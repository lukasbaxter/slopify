package com.lukasbaxter.slopify.android.core.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import java.util.concurrent.ConcurrentHashMap

/** Plain, non-secret per-install values (client id, UI conveniences). */
interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String?)
}

class SharedPrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
    constructor(context: Context, name: String = "slopify") : this(context.getSharedPreferences(name, Context.MODE_PRIVATE))

    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun putString(key: String, value: String?) = prefs.edit { if (value == null) remove(key) else putString(key, value) }
}

/** Tests and previews. */
class MemoryStore : KeyValueStore, SecureStore {
    private val map = ConcurrentHashMap<String, String>()
    override fun getString(key: String): String? = map[key]
    override fun putString(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    override fun load(key: String): String? = map[key]
    override fun save(key: String, value: String) { map[key] = value }
    override fun delete(key: String) { map.remove(key) }
}
