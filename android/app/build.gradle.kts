plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.lukasbaxter.slopify.android"
    compileSdk = 36

    defaultConfig {
        // The Expo app's id (owner, 11-12: the native app replaces it), so the release apk installs as an update over it.
        applicationId = "com.lukasbaxter.slopify"
        minSdk = 29
        targetSdk = 36
        // The release tag sets these (-PslopifyVersion=0.1.179 -> versionCode 1179, the Expo app's scheme).
        val version = (findProperty("slopifyVersion") as String?) ?: "0.1.0"
        val (a, b, c) = version.split(".").map { it.toInt() }
        versionCode = a * 1_000_000 + b * 1_000 + c
        versionName = version
    }

    // The release keystore (the Expo app's key, alias "conduit"); only CI has it. Without it, release is unsigned.
    val keystore = System.getenv("SLOPIFY_KEYSTORE")?.let { file(it) }?.takeIf { it.exists() }
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = keystore
                storePassword = System.getenv("CONDUIT_KS_PASS")
                keyAlias = "conduit"
                keyPassword = System.getenv("CONDUIT_KS_PASS")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = false
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        // "Zero warnings in our code" (docs/CONVENTIONS.md), enforced.
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.session)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
