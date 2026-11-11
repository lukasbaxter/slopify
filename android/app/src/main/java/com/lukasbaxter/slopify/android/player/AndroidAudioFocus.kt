package com.lukasbaxter.slopify.android.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat

/**
 * Audio focus (calls, other music apps, the assistant) and becoming-noisy (headphones or
 * Bluetooth gone), the iOS AudioSessionController role. One focus request for the app, not
 * one per ExoPlayer, so the crossfade's second player never takes focus from the first.
 * Ducking for notifications is left to the system (API 26+ ducks media itself).
 */
class AndroidAudioFocus(context: Context) : AudioFocusControlling {
    private val app = context.applicationContext
    private val am = app.getSystemService(AudioManager::class.java)
    override var onInterruptionBegan: (() -> Unit)? = null
    override var onInterruptionEnded: ((Boolean) -> Unit)? = null
    override var onRouteLost: (() -> Unit)? = null

    private var active = false
    private var transientLoss = false
    private var noisyRegistered = false

    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
        .setWillPauseWhenDucked(false)
        .setAcceptsDelayedFocusGain(false)
        .setOnAudioFocusChangeListener({ change -> focusChanged(change) }, Handler(Looper.getMainLooper()))
        .build()

    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) onRouteLost?.invoke()
        }
    }

    /** ExoPlayer's position already follows the audio pipeline's timestamps, latency included. */
    override val outputLatency: Double get() = 0.0

    override fun activate() {
        if (!noisyRegistered) {
            ContextCompat.registerReceiver(app, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
            noisyRegistered = true
        }
        if (active) return
        active = am.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    override fun deactivate() {
        if (noisyRegistered) { runCatching { app.unregisterReceiver(noisy) }; noisyRegistered = false }
        transientLoss = false
        if (!active) return
        active = false
        am.abandonAudioFocusRequest(request)
    }

    private fun focusChanged(change: Int) {
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                // Another app plays now: pause and give focus back; a later play asks again.
                transientLoss = false
                active = false
                am.abandonAudioFocusRequest(request)
                onInterruptionBegan?.invoke()
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                transientLoss = true
                onInterruptionBegan?.invoke()
            }
            AudioManager.AUDIOFOCUS_GAIN -> if (transientLoss) {
                transientLoss = false
                onInterruptionEnded?.invoke(true)
            }
            else -> Unit
        }
    }
}
