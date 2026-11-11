package com.lukasbaxter.slopify.android.features.nowplaying

import androidx.compose.runtime.Composable

// The shell's entry points, named like the iOS screens (ios/Slopify/Features/NowPlaying).

/** Full-screen now playing (UI.md 3.2). */
@Composable
fun NowPlayingView() = NowPlayingScreen()

/** The phone queue page (UI.md 3.3). */
@Composable
fun QueueView() = QueuePage()

/** "Connect to a device": the body of a bottom sheet (`BottomSheet(visible, ...) { DeviceSheet() }`). */
@Composable
fun DeviceSheet() = DeviceSheetBody()

/** The floating card above the tab bar (UI.md 3.1). */
@Composable
fun MiniPlayer() = MiniPlayerBar()
