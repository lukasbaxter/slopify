package com.lukasbaxter.slopify.android.core.auth

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The phone's current network path (the iOS NWPath role). `networkId` changes when the phone
 * moves to another network of the same kind, so a Wi-Fi to Wi-Fi move still re-chooses the address.
 */
data class NetworkPath(
    val satisfied: Boolean,
    val cellular: Boolean = false,
    val wifi: Boolean = false,
    val ethernet: Boolean = false,
    val networkId: Long = 0,
) {
    /** Only mobile data: LAN-only home addresses are skipped (§4.4 step 2). */
    val cellularOnly: Boolean get() = cellular && !wifi && !ethernet
}

interface NetworkMonitor {
    /** null until the first report. */
    val path: StateFlow<NetworkPath?>
}

/** Follows the default network through ConnectivityManager. */
class AndroidNetworkMonitor(context: Context) : NetworkMonitor {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val state = MutableStateFlow<NetworkPath?>(null)
    override val path: StateFlow<NetworkPath?> = state.asStateFlow()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            state.value = NetworkPath(
                satisfied = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                cellular = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                ethernet = caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
                networkId = network.networkHandle,
            )
        }

        override fun onLost(network: Network) {
            state.value = NetworkPath(satisfied = false)
        }
    }

    init {
        if (cm.activeNetwork == null) state.value = NetworkPath(satisfied = false)
        cm.registerDefaultNetworkCallback(callback)
    }

    fun stop() = cm.unregisterNetworkCallback(callback)
}

/** Tests and previews: set `path.value` by hand. */
class FakeNetworkMonitor(initial: NetworkPath? = NetworkPath(satisfied = true, wifi = true)) : NetworkMonitor {
    override val path = MutableStateFlow(initial)
}
