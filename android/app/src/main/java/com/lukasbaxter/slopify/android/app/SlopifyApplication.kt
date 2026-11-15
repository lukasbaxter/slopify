package com.lukasbaxter.slopify.android.app

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.lukasbaxter.slopify.android.features.widget.WidgetUpdater
import kotlinx.coroutines.MainScope

class SlopifyApplication : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        model = AppModel.create(this, MainScope())
        // Home screen widgets follow the player and Home's shortcuts for the whole process.
        WidgetUpdater.start(this, model)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = model.foreground()
            override fun onStop(owner: LifecycleOwner) = model.background()
        })
    }
}
