package com.lukasbaxter.slopify.android.features.nowplaying

import androidx.compose.runtime.Composable
import com.lukasbaxter.slopify.android.features.ScreenPlaceholder

// Placeholders named like the iOS screens (ios/Slopify/Features). TODO(features-nowplaying).

@Composable
fun NowPlayingView() = ScreenPlaceholder("NowPlayingView")

@Composable
fun QueueView() = ScreenPlaceholder("QueueView")

@Composable
fun DeviceSheet() = ScreenPlaceholder("DeviceSheet")

/** Above the tab bar; empty until the now-playing task builds it. */
@Composable
fun MiniPlayer() = Unit
