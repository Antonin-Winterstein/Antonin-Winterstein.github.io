// Test only: the worker calls its production API in hard, redirect those calls to the
// test instance behind the tunnel. Its statistics events would reach production: drop them.
const AIB_LOCAL = 'https://nhntamepba.a.pinggy.link';
const nativeFetch = self.fetch.bind(self);

self.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url.includes('execute-api')) {
        return Promise.resolve(new Response(null, {status: 204}));
    }

    return nativeFetch(
        typeof input === 'string'
            ? input.replace('https://app.allinbox.com/webpush/', AIB_LOCAL + '/webpush/')
            : input,
        init
    );
};

// Patched copy of the worker script, served by this site for the test.
importScripts('/assets/sdk/AIB.sw.js');
