package com.lukasbaxter.slopify.android.features.home

import androidx.compose.runtime.Composable
import com.lukasbaxter.slopify.android.app.SeeAllKind
import com.lukasbaxter.slopify.android.features.ScreenPlaceholder

// Placeholders named like the iOS screens (ios/Slopify/Features). TODO(features-home).

@Composable
fun HomeView() = ScreenPlaceholder("HomeView")

@Composable
fun DailyMixView(artistId: String, number: Int, seedName: String) = ScreenPlaceholder("DailyMixView $number $artistId $seedName")

@Composable
fun TopSongsView(year: Int, colorIndex: Int) = ScreenPlaceholder("TopSongsView $year $colorIndex")

@Composable
fun ReleaseRadarView() = ScreenPlaceholder("ReleaseRadarView")

@Composable
fun SeeAllView(kind: SeeAllKind) = ScreenPlaceholder("SeeAllView $kind")
