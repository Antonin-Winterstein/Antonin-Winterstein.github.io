// Test only: the web push SDK calls its production API in hard.
// Redirect those calls to the test instance, exposed by a tunnel.
// Nothing else is rewritten, so the chatbot keeps talking to production.
// Load this file WITHOUT defer, before the deferred SDK tag.
(() => {
    'use strict';

    const AIB_LOCAL = 'https://nhntamepba.a.pinggy.link';
    const nativeFetch = window.fetch.bind(window);

    window.fetch = (input, init) => nativeFetch(
        typeof input === 'string'
            ? input.replace('https://app.allinbox.com/webpush/', AIB_LOCAL + '/webpush/')
            : input,
        init
    );
})();
