import CarPlay
import UIKit

/// The CarPlay scene (Info.plist `CPTemplateApplicationSceneSessionRoleApplication`). The phone
/// window stays SwiftUI's WindowGroup; this scene only drives the car's templates, on the same
/// AppModel the phone uses.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var controller: CarPlayController?

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        MainActor.assumeIsolated {
            let c = CarPlayController(interfaceController: interfaceController, app: AppModel.current, scale: scene.carWindow.screen.scale)
            controller = c
            c.start()
        }
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        MainActor.assumeIsolated {
            controller?.stop()
            controller = nil
        }
    }
}
