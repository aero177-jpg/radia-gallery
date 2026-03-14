import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons';
import Modal from './Modal';

const Section = ({ title, children, isOpen = false }) => {
  return (
    <details
      open={isOpen}
      class="controls-section"
    >
      <summary class="controls-section__summary">
        <FontAwesomeIcon icon={faChevronRight} className="controls-section__chevron" />
        <span class="controls-section__title">{title}</span>
      </summary>
      <div class="controls-section__content">
        <div class="controls-section__content-inner">{children}</div>
      </div>
    </details>
  );
};

function ControlsModal({ isOpen, onClose, defaultOpenSubsections = [] }) {
  const openKeysSet = new Set(defaultOpenSubsections);
  const isSubsectionOpen = (key) => openKeysSet.has(key);
  const isAnyOpen = (keys) => keys.some((key) => openKeysSet.has(key));

  const gettingStartedKeys = [
    'getting-started.overview',
    'getting-started.viewer-overview',
    'getting-started.slideshow',
  ];
  const settingsKeys = [
    'settings.main-settings',
    'settings.additional-settings',
  ];
  const controlsKeys = ['controls.desktop', 'controls.mobile', 'controls.vr'];
  const connectionsKeys = ['connections.storage', 'connections.cloud-gpu'];
  const sharingKeys = ['sharing.transfer-bundles', 'sharing.embed-links'];
  const troubleshootingKeys = [
    'troubleshooting.render',
    'troubleshooting.collections',
    'troubleshooting.vr',
  ];

  const isGettingStartedOpen = isAnyOpen(gettingStartedKeys);
  const isSettingsOpen = isAnyOpen(settingsKeys);
  const isControlsOpen = isAnyOpen(controlsKeys);
  const isConnectionsOpen = isAnyOpen(connectionsKeys);
  const isSharingOpen = isAnyOpen(sharingKeys);
  const isTroubleshootingOpen = isAnyOpen(troubleshootingKeys);

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth={650} className="storage-dialog controls-modal">
      <div class="controls-modal">
        <h2 class="controls-modal__title">App overview</h2>
        <div class="controls-modal__scroll">
          <Section title="Getting Started" isOpen={isGettingStartedOpen}>
            <div class="controls-modal__intro">
              <p class="controls-modal__subtitle">
                This app has a focus on 3dgs files with an intended perspective, viewed in a gallery or animated slideshow format.
                This is not recommended for navigating large models or 360 exploration.
                We highly recommend using <strong>.sog</strong> formatted files for storage and performance gains.
              </p>
              <p class="controls-modal__subtitle" style={{ marginTop: "4px" }}>
                <a
                  href="https://github.com/aero177-jpg/ml-sharp-optimized"
                  target="_blank"
                  rel="noreferrer"
                >
                  Our ml-sharp fork
                </a>{' '}
                includes a fast .sog export in the pipeline, and includes camera metadata for clean integration with this viewer, as well as integrations with your connected storage.
              </p>
            </div>


            <Section title="Viewer overview" isOpen={isSubsectionOpen('getting-started.viewer-overview')}>
              <ul>
                <li><strong>View image:</strong> Drag your .ply or .sog files onto the page to create a quick collection. If a cloud GPU is configured, you can add image files and you will be prompted to upload them. You can also click “browse” to search your device.</li>
                <li><strong>Gallery:</strong> Click, swipe, or hover on the left side of the screen, or click the button in the bottom left corner. Here you can browse, add more images, or delete with additional options.</li>
                <li><strong>Main Settings:</strong> On desktop or landscape mode on mobile, click, swipe, or hover on the right side of the screen, or click the arrow in the upper right corner. On mobile portrait mode, tap or swipe up on the bottom menu handle.</li>
                <li><strong>Viewer buttons:</strong> Advance next/back and play/pause slideshow (if slideshow mode is toggled on). Buttons on the right side, from top to bottom, are reset view, expand viewer (coming soon), fullscreen toggle, and immersive mode (on mobile).</li>
              </ul>
            </Section>
            <Section title="Slideshow" isOpen={isSubsectionOpen('getting-started.slideshow')}>
              <ul>
                <li><strong>Start slideshow: </strong>Click the play icon on the bottom of the screen to toggle. pause by tapping the screen, or clicking the play/pause button.</li>
                <li><strong>Settings: </strong>Hold the play button to open slide settings.</li>
                <li><strong>Continuous mode:</strong> This replaces the slide in and out animation with a single sliding animation.</li>
                <li><strong>Zoom target:</strong> Sets a zoom limit for the current image, overriding slideshow continuous mode presets. "Far" is recommended for landscapes or distant subjects, for example.</li>
                <li><strong>Dolly zoom:</strong> Makes a visually interesting zoom effect, at the cost of revealing distortion or artifacts.</li>

                <li><strong>Transition Range:</strong> Adjusts how wide the orbit or zoom path is, but this can lead to seeing unwanted artifacts or warped splats. </li>
              </ul>
            </Section>

            <div class="controls-section-divider" />
          </Section>
          <Section title="Settings" isOpen={isSettingsOpen}>
            <Section title="Main Settings" isOpen={isSubsectionOpen('settings.main-settings')}>
              <ul>
                <li><strong>Quality:</strong> Adjusts model density. Experimental is a last resort option, not recommended. Further adjustments can be made in advanced settings.</li>
                <li><strong>Orbit range:</strong> ml-sharp splats degrade at greater angles, this mitigates this and keeps focus on the target view. Auto adjusts in immersive mode on mobile. Disabled for models missing ml-sharp metadata.</li>
                <li><strong>FOV:</strong> Auto adjust depending on camera metadata. Click the eye symbol to add a slider to the viewer for a dolly-zoom effect.</li>
                <li><strong>Recenter:</strong> Bring camera back to starting point. Hold to reset viewer, for example due to render glitch.</li>
                <li><strong>Set focus depth:</strong> Orbit and zoom to a specified depth. Either click on the model when prompted, or double click to focus on a point of interest, and click "set anchor as focus". Custom focus will be stored.</li>
              </ul>
            </Section>

            <Section title="Additional Settings" isOpen={isSubsectionOpen('settings.additional-settings')}>
              <ul>
                <li><strong>Custom Camera:</strong> This viewer auto sets the camera for optimal viewing of ml-sharp splats (with metadata). For others, manually adjust: scale to fill, rotate, double click, and zoom to frame intended view. You can add additional views on the same model, click "edit custom camera", adjust camera, and save as new view.</li>
                <li><strong>Tilt Sensitivity:</strong> Adjusts how device rotation effects view in immersive mode.</li>
                <li><strong>VR toggle:</strong> Appears if an HMD is detected.</li>
                <li><strong>SBS separation:</strong> Appears if sbs enabled in advanced settings (experimental). Effects stereo depth perceived. Click focus icon for auto adjust.</li>
                <li><strong>SBS stereo aspect:</strong> Manual aspect ratio adjustment to match display.</li>
              </ul>
            </Section>
            <div class="controls-section-divider" />

          </Section>

          <Section title="Controls" isOpen={isControlsOpen}>
            <Section title="Desktop" isOpen={isSubsectionOpen('controls.desktop')}>
              <ul>
                <li><strong>WASD QE:</strong> Navigate non ML-Sharp scenes. + <strong>shift</strong> to move faster.</li>
                <li><strong>Double click:</strong> Zoom/orbit around point (hit refresh to clear).</li>
                <li><strong>Click-drag:</strong> Orbit.</li>
                <li><strong>Right click-drag:</strong> Pan.</li>
                <li><strong>Scroll:</strong> Zoom.</li>
                <li><strong>Click:</strong> Interact with controls and viewer.</li>
                <li><strong>Spacebar:</strong> Play / pause slideshow.</li>
                <li><strong>Tap:</strong> Pause slideshow, toggle UI.</li>
                <li><strong>R key:</strong> Reset camera, or click focus icon in viewer.</li>
                <li><strong>F11:</strong> Opens normal browser fullscreen. You can also use the fullscreen button in the viewer controls.</li>
              </ul>
            </Section>

            <Section title="Mobile" isOpen={isSubsectionOpen('controls.mobile')}>
              <ul>
                <li>Pinch to zoom, drag to orbit, two finger drag to pan.</li>
                <li>Swipe or tap left side of screen to toggle gallery panel.</li>
                <li>In landscape, swipe/tap right side (or click upper right button) to open main menu. In portrait, swipe/tap bottom.</li>
                <li>Swipe left or right in the lower part of the viewer (area with arrows) to advance models.</li>
                <li><strong>Tap:</strong> Pause slideshow, toggle UI.</li>
                <li><strong>Immersive mode:</strong> Only tested on Android. Toggle with the “3d rotate” icon in the viewer. Drag to pan while moving the device to orbit. Click the focus icon to fix device sensor drift or set the current device angle as centered.</li>
              </ul>
            </Section>

            <Section title="VR" isOpen={isSubsectionOpen('controls.vr')}>
               <p className='controls-modal__subtitle'>VR mode is a bit experimental. In this mode, the model itself is being rotated, rather than you moving around the model.         <br />
              <br />   Splats that were not generated with ml-sharp may not align to view on first viewing, But poses can be saved, including rotation and scale. One VR pose can be set per model custom viewpoint. 
            </p>
              <ul>
                <li><strong>Right trigger near model:</strong> Grab and directly move the model with the right controller.</li>
                <li><strong>Right trigger + left trigger:</strong> Grab model, then use left trigger to lock a rotation axis.</li>
                <li><strong>Right stick:</strong> Pan the model left/right and up/down.</li>
                <li><strong>Right trigger + right stick up/down while grabbing:</strong> Smoothly scale the model larger or smaller.</li>
                <li><strong>Left stick:</strong> Rotate the model horizontally or vertically.</li>
                <li><strong>Left trigger + left stick up/down:</strong> Push or pull the model forward and backward in depth.</li>
                <li><strong>Left X / Y:</strong> Step scale down or up.</li>
                <li><strong>Left stick click:</strong> Reset model rotation.</li>
                <li><strong>Right stick click:</strong> Reset the VR view and model transform.</li>
                <li><strong>Right A / B:</strong> Previous or next model.</li>
              </ul>
            </Section>
            <div class="controls-section-divider" />

          </Section>

          <Section title="Connections" isOpen={isConnectionsOpen}>
            <p className='controls-modal__subtitle'>You can choose to add a remote connection, a local folder, or app storage (best for mobile or PWA desktop app). All remote connection configs are stored locally only, this app is strictly a frontend client. Configs can be exported/imported in advanced settings.         <br />
              <br />    models are not automatically cached in browser due to size constraints, but can be manually cached in advanced settings for offline viewing, and bandwidth savings.
            </p>

            <Section title="Storage" isOpen={isSubsectionOpen('connections.storage')}>
              <ul>
                <li><strong>None:</strong> Files are added for session storage only. This is the default if you just drag and drop files in, and is a good option for quick viewing of a few files, but files will need to be re-added each session and can't be added from mobile.</li>
                <li><strong>Local folder:</strong> This allows you to select a folder on your device to use as a collection. Files added to this folder will be added to the viewer, and files deleted from this folder will be removed from the viewer. This is a good option for desktop users who want to manage files locally. This must be given access for each new session.</li>
                <li><strong>Supabase:</strong> This is easy to setup, and requires only an API key and URL. When you set up policies, if you add "delete" this app can delete locally and in your storage. This solution has a smaller free tier storage, and charges for bandwith after 5gb a month. It does not require payment info to setup.</li>
                <li><strong>Cloudflare R2:</strong> This is a bit more complex to set up, and requires access key, Account ID, and secret key, but has a much larger free tier storage and bandwidth, and is a great option for large collections. Cloudflare requires payment info to sign up, but does not charge for bandwidth under their free tier.</li>
                <li><strong>URL List:</strong> This is a read-only option where you can input a list of public URLs to .sog or .ply files. This is a good option for sharing collections, but does not support adding or deleting files from the viewer.</li>
              </ul>

            </Section>
            <Section title="Local Encryption" isOpen={isSubsectionOpen('connections.storage')}>
              <p className='controls-modal__subtitle' style={{ marginBottom: "12px", fontSize: "13px" }}>This is not required, but you can choose to encrypt stored R2 and Modal access keys with a single password.</p>
              <ul>
                <li>You will be prompted for this password whenever decrypted keys are required, only needed once per session</li>
                <li>Keys are stored encrypted in local storage, so only accessible on the device they were set up on</li>
                <li>Password cannot be reset. You will need to reset the keys and set up your connections again</li>
              </ul>

            </Section>

            <Section title="Cloud GPU" isOpen={isSubsectionOpen('connections.cloud-gpu')}>
              <p className='controls-modal__subtitle' style={{ marginBottom: "12px", fontSize: "13px" }}>
                Using our  <a
                  href="https://github.com/aero177-jpg/ml-sharp-optimized"
                  target="_blank"
                  rel="noreferrer"
                >
                  our ml-sharp fork
                </a>{' '} and github action, you can set up a containerized version of ml-sharp on
                {' '}<a
                  href="https://modal.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  modal.com
                </a>{' '} using their free tier. It connects to this viewer for seamless uploads and processing.
                 If you are in a supabase or r2 collection, the results will be send to your storage and automatically added to the viewer. Otherwise, the files will be downloaded to your device to manually be added. 
                 <br/><br/>If you are in a temporary collection, your downloaded files will be removed when you exit, be sure to go to advanced settings and click "Export scenes".
              </p>

            </Section>
            <div class="controls-section-divider" />

          </Section>

          <Section title="Sharing" isOpen={isSharingOpen}>
            <Section title="Transfer bundles and config URLs" isOpen={isSubsectionOpen('sharing.transfer-bundles')}>
              <ul>
                <li><strong>Client-side only:</strong> This app does not keep your collections or connection setup on a server for you. If you want to move your current setup to another device or share it with someone else, export it from <strong>Transfer bundle</strong>.</li>
                <li><strong>Open import dialog:</strong> The import flow is available from the home page under <strong>Connect -&gt; Import configs</strong>, or from the sharing section inside the app settings.</li>
                <li><strong>Raw JSON export:</strong> Export JSON when you only need the saved collection/config data. Another user can import it by pasting the file directly, or you can host the JSON on a public URL such as npoint.io and import from that URL.</li>
                <li><strong>ZIP export:</strong> Export ZIP when you also want bundled previews for faster collection loading after import. ZIP exports can be imported from a public URL or by pasting/dropping the file directly into the import dialog.</li>
                <li><strong>Encrypted keys:</strong> If stored keys were encrypted when exported, they stay encrypted in the transfer bundle and will still require the same password after import on the new device.</li>
                <li><strong>Shareable config links:</strong> After uploading an exported JSON or ZIP to a public direct URL, use the generated config URL in the transfer dialog. That link adds your import URL to the viewer, so the recipient can open the app and import the shared setup from that hosted file.</li>
              </ul>
            </Section>

            <Section title="Embeddable link generator" isOpen={isSubsectionOpen('sharing.embed-links')}>
              <ul>
                <li><strong>What it does:</strong> The embed generator creates a read-only, stripped-down version of the app for sharing a collection without the full editing and management UI.</li>
                <li><strong>How it loads:</strong> The generated embed reads from a hosted JSON or ZIP config, so you can point it at the same exported transfer data you are sharing publicly.</li>
                <li><strong>Best use:</strong> Use embeds when you want a cleaner viewer experience for websites, portfolios, or simple sharing, while keeping the full app available separately for editing and imports.</li>
              </ul>
            </Section>
            <div class="controls-section-divider" />

          </Section>

          <Section title="Troubleshooting" isOpen={isTroubleshootingOpen}>
            <Section title="Render" isOpen={isSubsectionOpen('troubleshooting.render')}>
              <ul>
                <li><strong>Cropped render:</strong> The viewer crops models to improve performance. If edges are revealed in "fit to size", resize window or hold recenter button to fix.</li>
                <li><strong>Distorted preview:</strong> Previews generated on first load may capture partial renders. Click "regen preview" in advanced settings to fix (persisted).</li>
                <li><strong>Background glow:</strong> This is a copy of preview for visual effect. May not appear on first render. Regenerate preview to correct issues, or remove in advanced settings.</li>
                <li><strong>Missing previews:</strong> Only generated on first load. Click "batch previews" in advanced settings, or in the preview sidebar (available if multiple missing previews) to generate all.</li>
                <li><strong>'Cracks' in model:</strong> Thin areas may show cracks on performance or lower quality. "High" quality alleviates this but impacts performance.</li>
                <li><strong>Poor performance:</strong> This app is focused on model optimization, but some devices may still experience lag or stuttering. Integrated graphics, older mobile devices, and standalone VR headsets may be affected. Try adjusting quality presets, or adjust performance options in advanced settings. If running in browser, ensure that your dedicated GPU is utilized, and not your integrated graphics.</li>
              </ul>
            </Section>
            <Section title="Collections" isOpen={isSubsectionOpen('troubleshooting.collections')}>
              <ul>
                <li><strong>Files not appearing:</strong> If using a connected cloud storage, make sure you have the correct permissions set up. For Supabase, you can set up a policy with "select" permissions for the relevant table. For R2, make sure your access key and secret key are correct, and be sure to add a CORS policy under "settings".</li>
              </ul>
            </Section>

            <Section title="VR" isOpen={isSubsectionOpen('troubleshooting.vr')}>
              <ul>
                <li><strong>VR view misaligned:</strong> If your scenes have multiple custom camera poses, but you notice that the VR view doesn't align correctly with the model, this is likely due to a known issue with how we handle multiple custom views. As a workaround, you can switch to the desired custom camera pose, and then save a new VR view. This will capture the correct alignment for that pose. You can then switch between your saved VR view and custom camera poses as needed.</li> 
              </ul>
            </Section>
          </Section>

        </div>
      </div>
    </Modal>
  );
}

export default ControlsModal;
