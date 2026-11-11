package com.lukasbaxter.slopify.android.features.library

import androidx.compose.runtime.Composable

// Entry points named like the iOS screens (ios/Slopify/Features/Library); the shell calls these.

@Composable
fun LibraryView() = LibraryScreen()

@Composable
fun LikedSongsView() = LikedSongsScreen()

@Composable
fun PlaylistView(id: String) = PlaylistScreen(id)

@Composable
fun FolderView(id: String) = FolderScreen(id)
