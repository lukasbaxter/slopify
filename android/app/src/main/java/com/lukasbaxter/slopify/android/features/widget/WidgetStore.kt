package com.lukasbaxter.slopify.android.features.widget

import android.content.Context
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import java.io.File
import java.util.concurrent.Executors

/**
 * What the widgets show, live and on disk: one folder with `state.json` and the saved cover
 * pictures. A new process reads it back, so a widget draws its last state before (or without)
 * the player coming up.
 */
class WidgetStore(private val dir: File) {
    @Serializable
    private data class Kept(val snapshot: WidgetSnapshot = WidgetSnapshot(), val progress: Float? = null)

    private val snapshotFlow: MutableStateFlow<WidgetSnapshot>
    private val progressFlow: MutableStateFlow<Float?>
    val snapshot: StateFlow<WidgetSnapshot>
    /** The small widget's progress line, 0..1. Apart from [snapshot], so only that widget redraws for it. */
    val progress: StateFlow<Float?>

    init {
        val kept = runCatching { SlopifyJson.decodeFromString(Kept.serializer(), stateFile.readText()) }.getOrNull() ?: Kept()
        snapshotFlow = MutableStateFlow(kept.snapshot)
        progressFlow = MutableStateFlow(kept.progress)
        snapshot = snapshotFlow.asStateFlow()
        progress = progressFlow.asStateFlow()
    }

    private val stateFile get() = File(dir, "state.json")

    /** A saved picture's place. */
    fun file(name: String) = File(dir, name)

    fun update(f: (WidgetSnapshot) -> WidgetSnapshot) {
        val next = f(snapshotFlow.value)
        if (next == snapshotFlow.value) return
        snapshotFlow.value = next
        persist()
    }

    fun setProgress(p: Float?) {
        if (p == progressFlow.value) return
        progressFlow.value = p
        persist()
    }

    /** Signed out: nothing of the last account stays on the home screen. */
    fun clear() {
        snapshotFlow.value = WidgetSnapshot()
        progressFlow.value = null
        io.execute { dir.deleteRecursively() }
    }

    /** Drop the pictures nothing shows any more (never one just saved: its snapshot may be on the way). */
    fun prune(now: Long = System.currentTimeMillis()) {
        val s = snapshotFlow.value
        val keep = (s.tiles.mapNotNull { it.cover } + listOfNotNull(s.track?.cover)).toSet()
        io.execute {
            dir.listFiles()?.forEach {
                if (it.name.endsWith(".png") && it.name !in keep && now - it.lastModified() > 60_000) it.delete()
            }
        }
    }

    private fun persist() {
        val text = SlopifyJson.encodeToString(Kept.serializer(), Kept(snapshotFlow.value, progressFlow.value))
        io.execute {
            runCatching {
                dir.mkdirs()
                val tmp = File(dir, "state.json.tmp")
                tmp.writeText(text)
                if (!tmp.renameTo(stateFile)) { stateFile.delete(); tmp.renameTo(stateFile) }
            }
        }
    }

    /** Wait for the writes so far (tests). */
    internal fun flush() { io.submit {}.get() }

    companion object {
        /** Serial, so two writes never land out of order. */
        private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "slopify-widget-store").apply { isDaemon = true } }

        @Volatile private var instance: WidgetStore? = null

        /** The app's one store, in a folder that is never backed up to another phone. */
        fun shared(context: Context): WidgetStore = instance ?: synchronized(this) {
            instance ?: WidgetStore(File(context.applicationContext.noBackupFilesDir, "widget")).also { instance = it }
        }
    }
}
