package com.lukasbaxter.slopify.android.features.detail

import androidx.compose.runtime.Composable

// Entry points named like the iOS screens (ios/Slopify/Features/Detail).

/** Album page; `highlightTrack` lights and centres that song (a song link). */
@Composable
fun AlbumView(id: String, highlightTrack: String? = null) = DetailAlbumPage(id, highlightTrack)

/** Artist page. */
@Composable
fun ArtistView(id: String) = DetailArtistPage(id)
