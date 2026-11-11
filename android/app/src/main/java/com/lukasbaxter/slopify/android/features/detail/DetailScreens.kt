package com.lukasbaxter.slopify.android.features.detail

import androidx.compose.runtime.Composable
import com.lukasbaxter.slopify.android.features.ScreenPlaceholder

// Placeholders named like the iOS screens (ios/Slopify/Features). TODO(features-detail).

@Composable
fun AlbumView(id: String, highlightTrack: String? = null) = ScreenPlaceholder("AlbumView $id ${highlightTrack.orEmpty()}")

@Composable
fun ArtistView(id: String) = ScreenPlaceholder("ArtistView $id")
