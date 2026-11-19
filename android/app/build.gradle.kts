plugins {
    id("com.android.application")
}

// 签名：GitHub Actions 从 Secrets 里还原密钥文件，再通过环境变量告诉这里。
// 没有密钥时用临时的调试签名（能装，但每次签名不同，装新版前得先卸载旧版）。
val keystoreFile: String? = System.getenv("KEYSTORE_FILE")

android {
    namespace = "app.langhelper"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.langhelper"
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "0.1-dev"
        // 网页地址（只允许在这个网站里跳转，其他链接用浏览器打开）
        buildConfigField("String", "SHEET_URL", "\"https://stoney239.github.io/lang-helper/sheet.html\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            if (keystoreFile != null) {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (keystoreFile != null) "release" else "debug")
        }
    }

    // 自用、不上架：打包时不跑 lint，少一个出错的地方
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
