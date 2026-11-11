package com.lukasbaxter.slopify.android.features.search

import androidx.compose.runtime.Composable
import com.lukasbaxter.slopify.android.features.ScreenPlaceholder

// Placeholders named like the iOS screens (ios/Slopify/Features). TODO(features-search).

@Composable
fun SearchView() = ScreenPlaceholder("SearchView")

@Composable
fun GenreView(name: String) = ScreenPlaceholder("GenreView $name")

@Composable
fun SearchBrowsePage(charts: Boolean) = ScreenPlaceholder("SearchBrowsePage $charts")
