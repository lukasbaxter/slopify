plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.lukasbaxter.slopify.tv"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.lukasbaxter.slopify.tv"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
        buildConfigField("String", "SERVER_URL", "\"${project.findProperty("slopifyUrl") ?: "https://music.baxtergroup.io"}\"")
    }
    buildFeatures { buildConfig = true }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
