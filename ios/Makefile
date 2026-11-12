# make gen        generate Slopify.xcodeproj (XcodeGen)
# make build      simulator build
# make test       unit tests on a simulator
# make uitest     gesture UI tests against a local fixture server (UITEST_PORT, default 18765)
# make install    signed Release on a USB/Wi-Fi paired iPhone
#                 (DEVELOPMENT_TEAM=<id> once; it is kept in the git-ignored Local.xcconfig)
# DD=<dir> picks the derived-data dir, so parallel builds do not collide.
DEVELOPER_DIR ?= /Applications/Xcode.app/Contents/Developer
export DEVELOPER_DIR
XCRUN = DEVELOPER_DIR=$(DEVELOPER_DIR) xcrun
DD ?= build/dd
SIM ?= $(shell $(XCRUN) simctl list devices available -j | python3 -c 'import json,sys;d=json.load(sys.stdin)["devices"];print(next(x["udid"] for k in sorted(d,reverse=True) if "iOS" in k for x in d[k] if x["name"].startswith("iPhone")))')
DEVICE ?= $(shell $(XCRUN) devicectl list devices 2>/dev/null | awk '/available \(paired\)/ && /physical/ {for(i=1;i<=NF;i++) if ($$i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$$/) print $$i; exit}')
XB = xcodebuild -project Slopify.xcodeproj -scheme Slopify -derivedDataPath $(DD) -quiet

Local.xcconfig:
	@echo "DEVELOPMENT_TEAM = $(DEVELOPMENT_TEAM)" > $@

gen: Local.xcconfig
	@xcodegen generate --quiet

build: gen
	$(XB) -destination 'id=$(SIM)' build

test: gen
	$(XB) -destination 'id=$(SIM)' test $(if $(ONLY),-only-testing:$(ONLY))

UITEST_PORT ?= 18765
uitest: gen
	@URL=$$(tools/uitest-server.sh $(UITEST_PORT) $(abspath $(DD))/uitest-server) && \
	TEST_RUNNER_SLOPIFY_UITEST_SERVER=$$URL $(XB) -destination 'id=$(SIM)' test -only-testing:$(or $(ONLY),SlopifyUITests)

install: gen
	@grep -q 'DEVELOPMENT_TEAM = .\+' Local.xcconfig || { echo "set DEVELOPMENT_TEAM=<team id> (once)"; exit 1; }
	$(XB) -configuration Release -destination 'id=$(DEVICE)' -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
	$(XCRUN) devicectl device install app --device $(DEVICE) $(DD)/Build/Products/Release-iphoneos/Slopify.app

.PHONY: gen build test uitest install
