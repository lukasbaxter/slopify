package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.LanDevice
import com.lukasbaxter.slopify.android.core.session.SessionClient
import com.lukasbaxter.slopify.android.core.stores.Likes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.File

/**
 * Stand-in until the Media3 player lands. Keeps the queue and modes so screens can be built
 * against real state, but makes no sound and never talks to the session.
 */
class NoopPlayer : Player {
    private val mutable = MutableStateFlow(PlayerState())
    private val progressFlow = MutableStateFlow(PlayerProgress())
    override val state: StateFlow<PlayerState> = mutable.asStateFlow()
    override val progress: StateFlow<PlayerProgress> = progressFlow.asStateFlow()

    override var localFile: ((String) -> File?)? = null
    override var likes: Likes? = null
    override var onOfflinePlay: ((String, Double) -> Unit)? = null

    override fun attach(account: Account, session: SessionClient) = Unit
    override fun positionNow(): Double = progressFlow.value.position
    override fun outputLag(): Double = 0.0

    override fun play(tracks: List<Track>, startAt: Int, context: String?, shuffle: Boolean?) {
        val i = if (startAt in tracks.indices) startAt else 0
        mutable.update {
            it.copy(
                queue = tracks, queuedFlags = tracks.map { false }, recFlags = tracks.map { false }, index = i,
                context = context, shuffle = shuffle?.let { s -> if (s) ShuffleMode.On else ShuffleMode.Off } ?: it.shuffle,
            )
        }
        progressFlow.value = PlayerProgress(0.0, tracks.getOrNull(i)?.duration ?: 0.0)
    }

    override fun playNext(tracks: List<Track>) = insert(mutable.value.index + 1, tracks)
    override fun addToQueue(tracks: List<Track>) = insert(mutable.value.queue.size, tracks)

    private fun insert(at: Int, tracks: List<Track>) = mutable.update {
        val p = at.coerceIn(0, it.queue.size)
        it.copy(
            queue = it.queue.take(p) + tracks + it.queue.drop(p),
            queuedFlags = it.queuedFlags.take(p) + tracks.map { true } + it.queuedFlags.drop(p),
            recFlags = it.recFlags.take(p) + tracks.map { false } + it.recFlags.drop(p),
        )
    }

    override fun togglePlay() = Unit
    override fun setPlaying(playing: Boolean) = Unit
    override fun next() = skipTo(mutable.value.index + 1)
    override fun previous() = skipTo(mutable.value.index - 1)
    override fun seek(seconds: Double) { progressFlow.update { it.copy(position = seconds.coerceAtLeast(0.0), tick = it.tick + 1) } }
    override fun skipTo(index: Int) { if (index in mutable.value.queue.indices) mutable.update { it.copy(index = index) } }
    override fun setRepeat(mode: RepeatMode) = mutable.update { it.copy(repeatMode = mode) }
    override fun setShuffle(mode: ShuffleMode) = mutable.update { it.copy(shuffle = mode) }
    override fun setVolume(level: Double) = mutable.update { it.copy(volume = level.coerceIn(0.0, 100.0)) }

    override fun removeFromQueue(index: Int) = mutable.update {
        if (index !in it.queue.indices) return@update it
        it.copy(
            queue = it.queue.filterIndexed { i, _ -> i != index },
            queuedFlags = it.queuedFlags.filterIndexed { i, _ -> i != index },
            recFlags = it.recFlags.filterIndexed { i, _ -> i != index },
            index = if (index < it.index) it.index - 1 else it.index,
        )
    }

    override fun moveInQueue(from: Int, to: Int) = mutable.update {
        if (from !in it.queue.indices || to !in it.queue.indices) return@update it
        fun <T> List<T>.moved() = toMutableList().apply { add(to, removeAt(from)) }
        it.copy(queue = it.queue.moved(), queuedFlags = it.queuedFlags.moved(), recFlags = it.recFlags.moved())
    }

    override fun clearQueued() = mutable.update {
        val keep = it.queue.indices.filter { i -> i <= it.index || !it.queuedFlags.getOrElse(i) { false } }
        it.copy(queue = keep.map { i -> it.queue[i] }, queuedFlags = keep.map { i -> it.queuedFlags[i] }, recFlags = keep.map { i -> it.recFlags[i] })
    }

    override fun transferToClient(clientId: String?) = Unit
    override fun transferToSpeaker(device: LanDevice) = Unit
    override fun clearError() = mutable.update { it.copy(error = null) }
    override fun prewarm(track: Track) = Unit
}
