package com.lukasbaxter.slopify.android.design.components

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter

/**
 * The system share sheet (Android share intent; ios ShareSheet.swift). Shared by every feature.
 * When nothing can take the share, the link is copied and a toast says so.
 */
object ShareSheet {
    fun present(context: Context, url: String, title: String) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, url)
            putExtra(Intent.EXTRA_SUBJECT, title)
            putExtra(Intent.EXTRA_TITLE, title)
        }
        val chooser = Intent.createChooser(send, title).apply { if (context !is android.app.Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        try {
            context.startActivity(chooser)
        } catch (_: ActivityNotFoundException) {
            copy(context, url)
        }
    }

    private fun copy(context: Context, url: String) {
        val cm = context.getSystemService(ClipboardManager::class.java)
        if (cm == null) {
            ToastCenter.shared.show(L("Could not copy the link"))
            return
        }
        cm.setPrimaryClip(ClipData.newPlainText(url, url))
        ToastCenter.shared.show(L("Link copied"))
    }
}
