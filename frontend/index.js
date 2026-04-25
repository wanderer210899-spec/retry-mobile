import { bootRetryMobile } from './src/app.js';

let booted = false;

document.addEventListener('DOMContentLoaded', init);

if (document.readyState !== 'loading') {
    init();
}

function init() {
    if (booted) {
        return;
    }

    booted = true;
    void bootRetryMobile();
}
