plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "space.taskyon.constellation.plugin"
    compileSdk = 36

    defaultConfig { minSdk = 29 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/background-runtime"))
}

val workspaceRoot = projectDir.resolve("../../../..")
val buildBackgroundRuntime by tasks.registering(Exec::class) {
    workingDir(workspaceRoot)
    commandLine("yarn", "build:android:background-runtime")
    inputs.files(fileTree(workspaceRoot.resolve("src")))
    inputs.files(fileTree(workspaceRoot.resolve("vendor/taskyon")))
    inputs.file(workspaceRoot.resolve("vite.background.config.ts"))
    inputs.file(workspaceRoot.resolve("public/legacy-compat.js"))
    inputs.property("relayAddresses", providers.environmentVariable("VITE_CONSTELLATION_RELAY_ADDRS").orElse(""))
    outputs.dir(layout.buildDirectory.dir("generated/background-runtime"))
    doLast {
        copy {
            from(workspaceRoot.resolve("dist-background/constellation-background.js"))
            into(layout.buildDirectory.dir("generated/background-runtime"))
        }
    }
}
tasks.named("preBuild").configure { dependsOn(buildBackgroundRuntime) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation(project(":tauri-android"))
}
