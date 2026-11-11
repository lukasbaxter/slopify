# make build      debug APK (app/build/outputs/apk/debug/app-debug.apk)
# make test       JVM unit tests (ONLY=<pattern> runs matching tests, e.g. ONLY='*SessionClientTest')
# make install    debug APK on the attached device or emulator (adb; SERIAL=<id> picks one)
# Uses JDK 17 and the Android SDK from the environment, else the usual install spots.
JAVA_HOME ?= $(firstword $(wildcard /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/temurin-17-jdk-amd64))
export JAVA_HOME
ANDROID_HOME ?= $(firstword $(wildcard $(HOME)/Library/Android/sdk $(HOME)/Android/Sdk))
export ANDROID_HOME
ADB ?= $(if $(wildcard $(ANDROID_HOME)/platform-tools/adb),$(ANDROID_HOME)/platform-tools/adb,adb)
SERIAL ?= $(shell $(ADB) devices 2>/dev/null | awk 'NR>1 && $$2=="device" {print $$1; exit}')
GRADLE = ./gradlew --console=plain

build:
	$(GRADLE) :app:assembleDebug

test:
	$(GRADLE) :app:testDebugUnitTest $(if $(ONLY),--tests '$(ONLY)')

install: build
	@test -n "$(SERIAL)" || { echo "no device: plug one in (adb devices) or pass SERIAL=<id>"; exit 1; }
	$(ADB) -s $(SERIAL) install -r app/build/outputs/apk/debug/app-debug.apk

.PHONY: build test install
