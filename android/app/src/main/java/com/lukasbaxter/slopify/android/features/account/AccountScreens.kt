package com.lukasbaxter.slopify.android.features.account

import androidx.compose.runtime.Composable

// Entry points named like the iOS screens (ios/Slopify/Features/Account); the shell routes here.

@Composable
fun ProfileView() = AccountProfileScreen()

@Composable
fun HistoryView() = AccountHistoryScreen()

@Composable
fun DownloadsView() = AccountDownloadsScreen()

@Composable
fun SettingsView() = AccountSettingsScreen()

@Composable
fun ScrobblingView() = AccountScrobblingScreen()

/** The account drawer layer; it follows `nav.drawerOpen` itself, so the shell may always compose it. */
@Composable
fun AccountDrawer() = AccountDrawerLayer()
