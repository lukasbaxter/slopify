import XCTest
@testable import Slopify

final class SignInRulesTests: XCTestCase {
    func testServerFormMessages() {
        XCTAssertEqual(SignInRules.serverFormError(main: "  ", home: ""), "Enter the address of your Slopify server.")
        XCTAssertEqual(SignInRules.serverFormError(main: "-bad.com", home: ""), "That server address doesn’t look right. Try something like music.example.com.")
        XCTAssertEqual(SignInRules.serverFormError(main: "music.example.com", home: "ftp://x"), "That home address doesn’t look right. Try something like 192.168.1.10:8080.")
        XCTAssertNil(SignInRules.serverFormError(main: "music.example.com", home: ""))
        XCTAssertNil(SignInRules.serverFormError(main: "music.example.com", home: "192.168.1.10:8080"))
    }

    func testNoServerMessageUsesHostOnly() {
        XCTAssertEqual(SignInRules.noServerMessage(typed: "Music.Example.com/sub/"),
                       "No Slopify server answered at music.example.com. Check the address, and that the phone can reach it.")
        XCTAssertEqual(SignInRules.hostLabel(URL(string: "http://192.168.1.85:8080/x")!), "192.168.1.85:8080")
    }

    func testNewPassword() {
        XCTAssertEqual(SignInRules.newPasswordError("short", again: "short"), "Use 8 characters or more.")
        XCTAssertEqual(SignInRules.newPasswordError("longenough", again: "longenougH"), "The two passwords differ.")
        XCTAssertNil(SignInRules.newPasswordError("longenough", again: "longenough"))
    }

    func testErrorText() {
        XCTAssertEqual(SignInRules.message(for: APIError.http(401, "wrong username or password")), "401: wrong username or password")
        XCTAssertEqual(SignInRules.message(for: APIError.offline), "You’re offline")
    }

    func testInviteLink() {
        let r = SignInRules.invite(from: URL(string: "https://Music.Example.com:443/?invite=abc123")!)
        XCTAssertEqual(r?.base.absoluteString, "https://music.example.com")
        XCTAssertEqual(r?.code, "abc123")
        XCTAssertEqual(SignInRules.invite(from: URL(string: "http://192.168.1.85:8080/?invite=x")!)?.base.absoluteString, "http://192.168.1.85:8080")
        XCTAssertNil(SignInRules.invite(from: URL(string: "https://music.example.com/?x=1")!))
        XCTAssertNil(SignInRules.invite(from: URL(string: "https://music.example.com/?invite=")!))
    }

    func testDiscoveredAddress() {
        XCTAssertEqual(ServerBrowser.address(host: .ipv4(.init("192.168.1.85")!), port: 8080)?.absoluteString, "http://192.168.1.85:8080")
        XCTAssertEqual(ServerBrowser.address(host: .name("slopify-ab12cd34.local", nil), port: 80)?.absoluteString, "http://slopify-ab12cd34.local")
        XCTAssertNil(ServerBrowser.address(host: .ipv6(.loopback), port: 8080))
    }
}

@MainActor
private final class SignInFakeBackend: SignInBackend {
    var answering: Set<String> = []
    var demo = false
    var signInError: Error?
    var probes: [(String, TimeInterval)] = []
    var signIns: [(URL, String, String)] = []
    var registers: [(URL, String, String)] = []
    var passwords: [String] = []
    var homes: [URL] = []

    func probe(_ url: URL, timeout: TimeInterval) async -> Bool {
        probes.append((url.absoluteString, timeout)); return answering.contains(url.absoluteString)
    }
    func tryDemo(base: URL) async -> Bool { demo }
    func signIn(base: URL, username: String, password: String) async throws {
        if let signInError { throw signInError }
        signIns.append((base, username, password))
    }
    func register(base: URL, invite: String, username: String, password: String) async throws {
        registers.append((base, invite, username))
    }
    func changePassword(new: String) async throws { passwords.append(new) }
    func setHome(_ url: URL) { homes.append(url) }
}

@MainActor
final class SignInModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "SignInModelTests"

    override func setUp() {
        super.setUp()
        UserDefaults().removePersistentDomain(forName: suite)
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func make(_ b: SignInFakeBackend) -> SignInModel { SignInModel(backend: b, defaults: defaults) }

    func testStartsOnServerScreenWithNothingRemembered() async {
        let m = make(SignInFakeBackend())
        await m.start()
        XCTAssertEqual(m.stage, .server)
        XCTAssertFalse(m.canCancelServer)
    }

    func testValidationErrorDoesNotProbe() async {
        let b = SignInFakeBackend()
        let m = make(b)
        await m.connect()
        XCTAssertEqual(m.serverError, "Enter the address of your Slopify server.")
        XCTAssertTrue(b.probes.isEmpty)
    }

    func testProbesBothSchemesAndFallsBackToHttp() async {
        let b = SignInFakeBackend(); b.answering = ["http://music.example.com"]
        let m = make(b)
        m.main = "music.example.com"
        await m.connect()
        XCTAssertEqual(Set(b.probes.map(\.0)), ["https://music.example.com", "http://music.example.com"])
        XCTAssertTrue(b.probes.allSatisfy { $0.1 == SignInModel.mainTimeout })
        XCTAssertEqual(m.base?.absoluteString, "http://music.example.com")
        XCTAssertEqual(m.stage, .login)
        XCTAssertEqual(defaults.string(forKey: SignInModel.rememberKey), "http://music.example.com")
    }

    func testGuessWinsWhenBothAnswer() async {
        let b = SignInFakeBackend(); b.answering = ["http://music.example.com", "https://music.example.com"]
        let m = make(b)
        m.main = "music.example.com"
        await m.connect()
        XCTAssertEqual(m.base?.absoluteString, "https://music.example.com")
    }

    func testNothingAnswers() async {
        let b = SignInFakeBackend()
        let m = make(b)
        m.main = "music.example.com"
        await m.connect()
        XCTAssertEqual(m.stage, .server)
        XCTAssertNil(m.base)
        XCTAssertEqual(m.serverError, "No Slopify server answered at music.example.com. Check the address, and that the phone can reach it.")
    }

    func testHomeAloneIsEnoughAndHomeIsSetAfterSignIn() async {
        let b = SignInFakeBackend(); b.answering = ["http://192.168.1.85:8080", "https://music.example.com"]
        let m = make(b)
        m.main = "music.example.com"; m.home = "192.168.1.85:8080"
        await m.connect()
        XCTAssertTrue(b.probes.contains { $0.0 == "http://192.168.1.85:8080" && $0.1 == SignInModel.homeTimeout })
        XCTAssertEqual(m.base?.absoluteString, "https://music.example.com")
        XCTAssertEqual(m.pendingHome?.absoluteString, "http://192.168.1.85:8080")
        m.username = " lukas "; m.password = "pw"
        await m.logIn()
        XCTAssertEqual(b.signIns.first?.1, "lukas")
        XCTAssertEqual(b.homes.map(\.absoluteString), ["http://192.168.1.85:8080"])
        XCTAssertNil(m.pendingHome)

        let b2 = SignInFakeBackend(); b2.answering = ["http://192.168.1.85:8080"]
        let m2 = make(b2)
        m2.main = "music.example.com"; m2.home = "192.168.1.85:8080"
        await m2.connect()
        XCTAssertEqual(m2.base?.absoluteString, "http://192.168.1.85:8080")
        XCTAssertNil(m2.pendingHome)
    }

    func testDemoServerNeverShowsTheForm() async {
        let b = SignInFakeBackend(); b.answering = ["https://music.example.com"]; b.demo = true
        let m = make(b)
        m.main = "music.example.com"
        await m.connect()
        XCTAssertEqual(m.stage, .starting)
        XCTAssertTrue(b.signIns.isEmpty)
    }

    func testRememberedServerSkipsServerScreen() async {
        defaults.set("https://music.example.com", forKey: SignInModel.rememberKey)
        let m = make(SignInFakeBackend())
        XCTAssertEqual(m.main, "https://music.example.com")
        await m.start()
        XCTAssertEqual(m.stage, .login)
        XCTAssertTrue(m.canCancelServer)
        m.editServer()
        XCTAssertEqual(m.stage, .server)
        m.cancelServerEdit()
        XCTAssertEqual(m.stage, .login)
    }

    func testLoginNeedsAUsernameAndShowsServerError() async {
        defaults.set("https://music.example.com", forKey: SignInModel.rememberKey)
        let b = SignInFakeBackend(); b.signInError = APIError.http(401, "wrong username or password")
        let m = make(b)
        await m.start()
        XCTAssertFalse(m.canLogIn)
        await m.logIn()
        XCTAssertNil(m.loginError)
        m.username = "lukas"; m.password = "nope"
        XCTAssertTrue(m.canLogIn)
        await m.logIn()
        XCTAssertEqual(m.loginError, "401: wrong username or password")
        XCTAssertFalse(m.busy)
    }

    func testInviteRegistersAndSkipsDemo() async {
        let b = SignInFakeBackend(); b.demo = true
        let m = make(b)
        await m.acceptInvite(URL(string: "https://music.example.com/?invite=code1")!)
        XCTAssertEqual(m.stage, .login)
        XCTAssertEqual(m.invite, "code1")
        m.username = "newbie"; m.password = "longenough"
        await m.logIn()
        XCTAssertEqual(b.registers.first?.0.absoluteString, "https://music.example.com")
        XCTAssertEqual(b.registers.first?.1, "code1")
        XCTAssertTrue(b.signIns.isEmpty)
        XCTAssertNil(m.invite)
    }

    func testChangePasswordValidatesFirst() async {
        let b = SignInFakeBackend()
        let m = make(b)
        XCTAssertFalse(m.canSavePassword)
        m.newPassword = "short"; m.again = "short"
        await m.savePassword()
        XCTAssertEqual(m.passwordError, "Use 8 characters or more.")
        m.newPassword = "longenough"; m.again = "different1"
        await m.savePassword()
        XCTAssertEqual(m.passwordError, "The two passwords differ.")
        XCTAssertTrue(b.passwords.isEmpty)
        m.again = "longenough"
        await m.savePassword()
        XCTAssertNil(m.passwordError)
        XCTAssertEqual(b.passwords, ["longenough"])
    }

    func testUseDiscoveredFillsField() {
        let m = make(SignInFakeBackend())
        m.use(URL(string: "http://192.168.1.85:8080")!)
        XCTAssertEqual(m.main, "http://192.168.1.85:8080")
    }
}
