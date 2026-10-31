package expo.modules.slopifymedia

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import java.net.HttpURLConnection
import java.net.URL

// The music plays in the WebView; this service is what Android needs around
// it. A foreground service of type mediaPlayback: without one, Android 16
// refuses audio focus to an app in the background ("AudioHardening focus
// request ... ignored"), so the WebView could not start the next song with
// the screen off. And a MediaSession with its notification: the lock screen,
// the notification shade, Bluetooth headsets and watches get the song and
// play / pause / previous / next / seek.
class SlopifyMediaService : Service() {
  companion object {
    var onAction: ((String, Double?) -> Unit)? = null
    private var latest: MediaState? = null
    private var instance: SlopifyMediaService? = null
    private const val CHANNEL = "slopify-playback"
    private const val NOTIFICATION_ID = 7781
    // A session paused this long lets go of the notification and the service.
    private const val PAUSED_LINGER_MS = 30 * 60 * 1000L

    fun update(ctx: Context, s: MediaState) {
      latest = s
      val svc = instance
      if (svc != null) { svc.apply(s); return }
      // Only music starting brings the service up (a paused or empty session does not).
      if (s.state != "playing") return
      ContextCompat.startForegroundService(ctx, Intent(ctx, SlopifyMediaService::class.java))
    }
    fun stop(ctx: Context) {
      latest = null
      instance?.let { it.shutdown() } ?: ctx.stopService(Intent(ctx, SlopifyMediaService::class.java))
    }
  }

  private lateinit var session: MediaSessionCompat
  private val main = Handler(Looper.getMainLooper())
  private var art: Pair<String, Bitmap?>? = null
  private var shown: MediaState? = null
  private val linger = Runnable { shutdown() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
    }
    session = MediaSessionCompat(this, "Slopify").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() = send("play")
        override fun onPause() = send("pause")
        override fun onSkipToNext() = send("nexttrack")
        override fun onSkipToPrevious() = send("previoustrack")
        override fun onStop() = send("pause")
        override fun onSeekTo(pos: Long) = send("seekto", pos / 1000.0)
      })
      packageManager.getLaunchIntentForPackage(packageName)?.let {
        setSessionActivity(PendingIntent.getActivity(this@SlopifyMediaService, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      }
      isActive = true
    }
  }

  private fun send(action: String, seek: Double? = null) { main.post { onAction?.invoke(action, seek) } }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Foreground at once, whatever the intent: Android stops an app that
    // asked for a foreground service and did not become one within seconds.
    val s = latest ?: MediaState("paused", "Slopify", "", "", null, null, null, 1.0, System.currentTimeMillis(), emptyList())
    goForeground(build(s))
    when (intent?.action) {
      "slopify.play" -> send("play")
      "slopify.pause" -> send("pause")
      "slopify.next" -> send("nexttrack")
      "slopify.prev" -> send("previoustrack")
    }
    apply(s)
    return START_NOT_STICKY
  }

  private fun goForeground(n: Notification) {
    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    else startForeground(NOTIFICATION_ID, n)
  }

  fun apply(s: MediaState) {
    if (s.state == "none") { shutdown(); return }
    main.removeCallbacks(linger)
    if (s.state != "playing") main.postDelayed(linger, PAUSED_LINGER_MS)
    val md = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, s.title)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, s.artist)
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, s.album)
    s.duration?.let { if (it > 0) md.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (it * 1000).toLong()) }
    val bitmap = artFor(s.artwork)
    if (bitmap != null) md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, bitmap)
    session.setMetadata(md.build())

    var actions = 0L
    if ("play" in s.actions || "pause" in s.actions) actions = actions or PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE
    if ("nexttrack" in s.actions) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
    if ("previoustrack" in s.actions) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
    if ("seekto" in s.actions) actions = actions or PlaybackStateCompat.ACTION_SEEK_TO
    val playing = s.state == "playing"
    // The position the page told, moved on to now on the elapsed-time clock.
    val pos = ((s.position ?: 0.0) * 1000 + if (playing) (System.currentTimeMillis() - s.at) * s.rate else 0.0).toLong().coerceAtLeast(0)
    session.setPlaybackState(PlaybackStateCompat.Builder()
      .setActions(actions)
      .setState(if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED, pos, if (playing) s.rate.toFloat() else 0f, SystemClock.elapsedRealtime())
      .build())
    val nm = getSystemService(NotificationManager::class.java)
    nm.notify(NOTIFICATION_ID, build(s, bitmap))
    shown = s
  }

  private fun build(s: MediaState, bitmap: Bitmap? = null): Notification {
    val playing = s.state == "playing"
    val action = { icon: Int, title: String, a: String ->
      NotificationCompat.Action(icon, title, PendingIntent.getService(this, a.hashCode(), Intent(this, SlopifyMediaService::class.java).setAction(a), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
    val b = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.slopify_media_note)
      .setContentTitle(s.title)
      .setContentText(s.artist)
      .setSubText(s.album.takeIf { it.isNotEmpty() })
      .setLargeIcon(bitmap)
      .setContentIntent(session.controller.sessionActivity)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setOngoing(playing)
      .addAction(action(android.R.drawable.ic_media_previous, "Previous", "slopify.prev"))
      .addAction(if (playing) action(android.R.drawable.ic_media_pause, "Pause", "slopify.pause") else action(android.R.drawable.ic_media_play, "Play", "slopify.play"))
      .addAction(action(android.R.drawable.ic_media_next, "Next", "slopify.next"))
      .setStyle(MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
    return b.build()
  }

  // Covers come from the server by plain URL (public by id); fetched once
  // each, off the main thread, then the notification is redrawn.
  private fun artFor(url: String?): Bitmap? {
    if (url.isNullOrEmpty()) return null
    art?.let { if (it.first == url) return it.second }
    art = url to null
    Thread {
      val bmp = try {
        (URL(url).openConnection() as HttpURLConnection).run {
          connectTimeout = 5000; readTimeout = 8000
          inputStream.use { BitmapFactory.decodeStream(it) }
        }
      } catch (_: Exception) { null }
      main.post { if (art?.first == url) { art = url to bmp; shown?.let { if (instance === this) apply(it) } } }
    }.start()
    return null
  }

  fun shutdown() {
    main.removeCallbacks(linger)
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  override fun onDestroy() {
    instance = null
    session.isActive = false
    session.release()
    super.onDestroy()
  }
}
