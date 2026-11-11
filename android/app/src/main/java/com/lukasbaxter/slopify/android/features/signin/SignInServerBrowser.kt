package com.lukasbaxter.slopify.android.features.signin

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import com.lukasbaxter.slopify.android.core.auth.Address
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.Inet4Address
import java.net.InetAddress

/** A Slopify server found on this network. */
internal data class SignInFoundServer(val id: String, val name: String, val address: String)

/**
 * Slopify servers on this network (API.md 4.6): DNS-SD `_slopify._tcp`, TXT `id` + `name`.
 * Android only hands out TXT and addresses after a resolve, so each service is resolved as it
 * appears and listed once it has an IPv4 address. Call from the main thread.
 */
internal class SignInServerBrowser(context: Context) {
    private val nsd: NsdManager? = context.getSystemService(NsdManager::class.java)
    private val executor = ContextCompat.getMainExecutor(context)
    private val main = Handler(Looper.getMainLooper())

    private val foundFlow = MutableStateFlow<List<SignInFoundServer>>(emptyList())
    val found: StateFlow<List<SignInFoundServer>> = foundFlow.asStateFlow()

    private var listener: NsdManager.DiscoveryListener? = null
    private val byService = LinkedHashMap<String, SignInFoundServer>()
    /** API 34+: one live info callback per service. */
    private val watching = HashMap<String, Any>()
    /** Before API 34 only one resolve may run at a time. */
    private val queue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false

    fun start() {
        val nsd = nsd ?: return
        if (listener != null) return
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { main.post { if (listener === this) listener = null } }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) { main.post { if (listener === this) resolve(serviceInfo) } }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) { main.post { if (listener === this) lost(serviceInfo.serviceName) } }
        }
        listener = l
        runCatching { nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l) }.onFailure { listener = null }
    }

    fun stop() {
        val nsd = nsd ?: return
        listener?.let { l -> runCatching { nsd.stopServiceDiscovery(l) } }
        listener = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) unwatchAll(nsd)
        watching.clear(); queue.clear(); resolving = false
        byService.clear(); publish()
    }

    private fun resolve(info: NsdServiceInfo) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) watch(info)
        else { queue.addLast(info); next() }
    }

    private fun lost(service: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) unwatch(service)
        if (byService.remove(service) != null) publish()
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun watch(info: NsdServiceInfo) {
        val nsd = nsd ?: return
        val service = info.serviceName
        if (watching.containsKey(service)) return
        val cb = object : NsdManager.ServiceInfoCallback {
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = Unit
            override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
                if (watching[service] === this) update(service, serviceInfo, serviceInfo.hostAddresses)
            }
            override fun onServiceLost() { if (watching[service] === this && byService.remove(service) != null) publish() }
            override fun onServiceInfoCallbackUnregistered() = Unit
        }
        watching[service] = cb
        runCatching { nsd.registerServiceInfoCallback(info, executor, cb) }.onFailure { watching.remove(service) }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun unwatch(service: String) {
        val cb = watching.remove(service) as? NsdManager.ServiceInfoCallback ?: return
        runCatching { nsd?.unregisterServiceInfoCallback(cb) }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun unwatchAll(nsd: NsdManager) {
        for (cb in watching.values) runCatching { nsd.unregisterServiceInfoCallback(cb as NsdManager.ServiceInfoCallback) }
    }

    // resolveService and NsdServiceInfo.host are deprecated from API 34, where watch() is used.
    @Suppress("DEPRECATION")
    private fun next() {
        val nsd = nsd ?: return
        if (resolving) return
        val info = queue.removeFirstOrNull() ?: return
        resolving = true
        val l = listener
        val done = { resolved: NsdServiceInfo? ->
            main.post {
                if (listener !== l || l == null) return@post
                resolving = false
                resolved?.let { update(it.serviceName, it, listOfNotNull(it.host)) }
                next()
            }
            Unit
        }
        val ok = runCatching {
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { done(null) }
                override fun onServiceResolved(serviceInfo: NsdServiceInfo) { done(serviceInfo) }
            })
        }.isSuccess
        if (!ok) { resolving = false; next() }
    }

    private fun update(service: String, info: NsdServiceInfo, hosts: List<InetAddress>) {
        val address = hosts.firstNotNullOfOrNull { address(it, info.port) } ?: return
        val txt = runCatching { info.attributes }.getOrNull().orEmpty()
        fun value(k: String) = txt[k]?.let { String(it, Charsets.UTF_8) }?.takeIf { it.isNotEmpty() }
        byService[service] = SignInFoundServer(id = value("id") ?: service, name = value("name") ?: service, address = address)
        publish()
    }

    private fun publish() {
        foundFlow.value = byService.values.distinctBy { it.id }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    companion object {
        const val SERVICE_TYPE = "_slopify._tcp"

        /**
         * The plain http address behind a found service (the server advertises its HTTP port).
         * IPv4 only: a link-local IPv6 needs a zone that URLs carry badly.
         */
        fun address(host: InetAddress, port: Int): String? =
            if (host is Inet4Address) host.hostAddress?.let { address(it, port) } else null

        /** A host name or IPv4 literal; IPv6 literals are refused. */
        fun address(host: String, port: Int): String? {
            val bare = host.substringBefore('%')
            if (':' in bare || bare.isEmpty()) return null
            return Address.normalise("http://$bare:$port")
        }
    }
}
