package com.lukasbaxter.slopify.android.features.library

import androidx.compose.runtime.Composable
import com.lukasbaxter.slopify.android.features.ScreenPlaceholder

// Placeholders named like the iOS screens (ios/Slopify/Features). TODO(features-library).

@Composable
fun LibraryView() = ScreenPlaceholder("LibraryView")

@Composable
fun LikedSongsView() = ScreenPlaceholder("LikedSongsView")

@Composable
fun PlaylistView(id: String) = ScreenPlaceholder("PlaylistView $id")

@Composable
fun FolderView(id: String) = ScreenPlaceholder("FolderView $id")
