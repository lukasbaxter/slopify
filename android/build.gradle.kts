plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}

// Parallel agents: `make ... TASK=<name>` builds into build-<name>/ (and its own .gradle-<name>
// cache), so concurrent builds never wait on each other's locks.
val slopifyTask = providers.gradleProperty("slopify.task").orNull
if (!slopifyTask.isNullOrBlank()) {
    allprojects {
        layout.buildDirectory.set(rootProject.layout.projectDirectory.dir("build-$slopifyTask/${project.name}"))
    }
}
