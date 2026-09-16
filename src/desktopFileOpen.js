let pendingLaunches = [];
let launchPending = false;
let processing = false;
let fileConsumer = null;
const pendingListeners = new Set();

const setLaunchPending = (pending) => {
	launchPending = pending;
	pendingListeners.forEach((listener) => listener(pending));
};

const processPendingLaunches = async () => {
	if (processing || !fileConsumer || pendingLaunches.length === 0) return;

	processing = true;
	fileConsumer.onOpening();

	try {
		while (pendingLaunches.length > 0 && fileConsumer) {
			const handles = pendingLaunches.shift();
			const files = await Promise.all(handles.map((handle) => handle.getFile()));
			if (files.length > 0) {
				await fileConsumer.onFiles(files);
			}
		}
	} catch (error) {
		console.error('[PWA] Failed to open launched file:', error);
	} finally {
		processing = false;
		if (pendingLaunches.length === 0) {
			setLaunchPending(false);
		} else {
			void processPendingLaunches();
		}
	}
};

if (typeof window !== 'undefined' && 'launchQueue' in window) {
	window.launchQueue.setConsumer((launchParams) => {
		const handles = launchParams.files || [];
		if (handles.length === 0) return;

		pendingLaunches.push(handles);
		setLaunchPending(true);
		void processPendingLaunches();
	});
}

export const hasPendingDesktopFileOpen = () => launchPending;

export const subscribeDesktopFileOpenPending = (listener) => {
	pendingListeners.add(listener);
	listener(launchPending);
	return () => pendingListeners.delete(listener);
};

export const initializeDesktopFileOpen = async (
	onFiles,
	onOpening = () => {},
) => {
	fileConsumer = { onFiles, onOpening };
	void processPendingLaunches();

	return () => {
		fileConsumer = null;
	};
};