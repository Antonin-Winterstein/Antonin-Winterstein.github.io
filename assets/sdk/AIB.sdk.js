// === CLASS DEFINITION === //
class PushSubscriptionManager {
    constructor(channelToken, subscriberId = null, lang = 'fr', swPath = '/AIBSDKWorker.js', swScope = '/') {
        this.applicationServerKey = null;
        this.channelToken = channelToken;
        this.subscriberId = subscriberId;
        this.lang = lang || 'fr';
        this.promptConfig = null;
        this.swPath = swPath || '/AIBSDKWorker.js';
        this.swScope = swScope || '/';

        // IndexedDB key of this channel's state, set once the worker is
        // registered. Several channels can share an origin (one per folder of
        // a WordPress multisite), each with its own worker: keying the state
        // by the worker's scope keeps their subscriptions apart, and the worker
        // can find the same record from its own registration.
        this.credentialsKey = null;

        // The VAPID public key and prompt config are immutable-per-channel
        // (the key is generated once at channel creation and never rotated).
        // Cache them client-side so we don't hit /webpush/api/channels/vapid
        // (CORS preflight + GET + a DB lookup) on every single page load.
        this.vapidCacheTtlMs = 24 * 60 * 60 * 1000; // 24h

        this.isFirefox = navigator.userAgent.indexOf("Firefox") !== -1;
        this.isSafari = navigator.userAgent.indexOf("Safari") !== -1 && navigator.userAgent.indexOf("Chrome") === -1;
        this.isEdge = navigator.userAgent.indexOf("Edg") !== -1;
        this.alwaysShowCustomPrompt = this.isFirefox || this.isSafari || this.isEdge;

        this.translations = {
            "en": {
                "title": "Turn on notifications",
                "text": "We will keep you informed about news.",
                "deny": "No thanks",
                "allow": "Allow"
            },
            "fr": {
                "title": "Activer les notifications",
                "text": "Nous vous tiendrons inform\u00e9 des nouveaut\u00e9s.",
                "deny": "Non merci",
                "allow": "Autoriser"
            },
            "es": {
                "title": "Activar las notificaciones",
                "text": "Te mantendremos informado de las novedades.",
                "deny": "No gracias",
                "allow": "Permitir"
            },
            "de": {
                "title": "Benachrichtigungen aktivieren",
                "text": "Wir halten Sie \u00fcber Neuigkeiten auf dem Laufenden.",
                "deny": "Nein danke",
                "allow": "Erlauben"
            },
            "it": {
                "title": "Attiva le notifiche",
                "text": "Ti terremo aggiornato sulle novit\u00e0.",
                "deny": "No grazie",
                "allow": "Consenti"
            },
            "pt": {
                "title": "Ativar notifica\u00e7\u00f5es",
                "text": "Vamos mant\u00ea-lo informado sobre novidades.",
                "deny": "N\u00e3o obrigado",
                "allow": "Permitir"
            },
            "nl": {
                "title": "Meldingen inschakelen",
                "text": "We houden je op de hoogte van nieuws.",
                "deny": "Nee bedankt",
                "allow": "Toestaan"
            },
            "pl": {
                "title": "W\u0142\u0105cz powiadomienia",
                "text": "B\u0119dziemy informowa\u0107 Ci\u0119 o nowo\u015bciach.",
                "deny": "Nie, dzi\u0119kuj\u0119",
                "allow": "Zezw\u00f3l"
            },
            "ru": {
                "title": "\u0412\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f",
                "text": "\u041c\u044b \u0431\u0443\u0434\u0435\u043c \u0434\u0435\u0440\u0436\u0430\u0442\u044c \u0432\u0430\u0441 \u0432 \u043a\u0443\u0440\u0441\u0435 \u043d\u043e\u0432\u043e\u0441\u0442\u0435\u0439.",
                "deny": "\u041d\u0435\u0442, \u0441\u043f\u0430\u0441\u0438\u0431\u043e",
                "allow": "\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044c"
            },
            "tr": {
                "title": "Bildirimleri a\u00e7",
                "text": "Seni yeniliklerden haberdar edece\u011fiz.",
                "deny": "Hay\u0131r te\u015fekk\u00fcrler",
                "allow": "\u0130zin ver"
            }
        };
    }

    init() {
        if (!this.isPushSupported()) {
            return;
        }

        if (Notification.permission === 'denied') {
            return;
        }

        if (this.alwaysShowCustomPrompt && this.hasUserDeclinedCustomNotificationPrompt()) {
            return;
        }

        // Register the SW and check for an existing subscription first. An
        // already-subscribed visitor only needs a PUT to refresh it, which
        // uses neither the VAPID key nor the prompt config, so we skip the
        // /vapid round-trip entirely for them. The key and prompt config are
        // loaded lazily below, only on the path that actually (re)subscribes.
        navigator.serviceWorker.register(this.swPath, {scope: this.swScope})
            .then(registration => {
                this.credentialsKey = `scope:${registration.scope}`;
                return navigator.serviceWorker.ready;
            })
            .then(swRegistration => swRegistration.pushManager.getSubscription())
            .then(async (subscription) => {
                if (subscription) {
                    return this.sendSubscriptionToServer(subscription, 'PUT');
                }

                // No active subscription → we may need to (re)subscribe, which
                // needs the VAPID key (and the prompt config for the gates
                // below). Fetch/load them now, not before.
                await this.ensureVapidKey();

                if (this.shouldShowCustomPrompt() && this.hasUserDeclinedCustomNotificationPrompt()) {
                    return null;
                }

                // Two unsubscribe-tracking mechanisms guard re-subscribing:
                //   - IndexedDB credentials (long-term, 30-day) detect a
                //     user-driven unsubscribe via Chrome's bell or browser
                //     settings.
                //   - localStorage engagement (7-day, per channel) detects
                //     "user clicked Allow on custom popup but the native prompt
                //     didn't conclude" so we don't re-pester on every page nav.

                const creds = await this.readCredentials();
                const cooldownMs = 30 * 24 * 60 * 60 * 1000; // 30 days

                if (creds && creds.endpoint) {
                    // Had a subscription previously, none now → the user
                    // unsubscribed (typically via Chrome's "Unsubscribe"
                    // button). Clean up backend and start a cooldown so we
                    // don't silently re-subscribe on later visits.
                    await this.deleteSubscriptionOnServer(creds.endpoint);
                    await this.storeCredentials({endpoint: null, unsubscribedAt: Date.now()});
                    return null;
                }

                if (creds && creds.unsubscribedAt && (Date.now() - creds.unsubscribedAt) < cooldownMs) {
                    // Still within the post-unsubscribe cooldown — respect the
                    // user's choice and stay silent.
                    return null;
                }

                if (creds && creds.unsubscribedAt) {
                    // Cooldown expired → forget the flag and treat the visitor
                    // as fresh.
                    await this.storeCredentials({unsubscribedAt: null});
                }

                // Permission already granted but no subscription left
                // (browser-side rotation, previous subscribe() rejected, etc.,
                // AND no recent unsubscribe — handled above). Re-subscribe
                // silently, no popup, no native prompt.
                if (Notification.permission === 'granted') {
                    // The browser grants notifications to a whole origin, not to
                    // one channel. When another channel of this origin may hold
                    // that permission and this channel never had a subscription
                    // in this browser, the visitor never agreed to hear from this
                    // channel: ask with our popup first. The browser itself asks
                    // nothing, since the permission is already granted.
                    if (!(creds && creds.subscribedAt) && await this.hasAnotherChannelOnOrigin()) {
                        if (this.hasUserDeclinedCustomNotificationPrompt()) {
                            return null;
                        }

                        if (!await this.showCustomNotificationPrompt()) {
                            return null;
                        }
                    }

                    return navigator.serviceWorker.ready
                        .then(reg => reg.pushManager.subscribe({
                            userVisibleOnly: true,
                            applicationServerKey: this.urlBase64ToUint8Array(this.applicationServerKey),
                        }))
                        .then(newSub => newSub
                            ? this.sendSubscriptionToServer(newSub, 'POST')
                            : null)
                        .catch(err => {
                            // A subscribe failure is the symptom of a stale
                            // cached key: drop it so we refetch next time.
                            this.invalidateVapidCache();
                            throw err;
                        });
                }

                // Permission still 'default' and the user already engaged with
                // the custom popup recently (clicked Allow). Don't re-pester
                // them on every page nav.
                if (this.shouldShowCustomPrompt() && this.hasUserRecentlyEngagedWithCustomPrompt()) {
                    return null;
                }

                // Fresh visitor → normal request flow.
                return this.requestPermission()
                    .then(newSubscription => {
                        if (!newSubscription) {
                            return null;
                        }

                        return this.sendSubscriptionToServer(newSubscription, 'POST');
                    });
            })
            .catch(err => {
                console.error('[AIB SDK] Error during subscription', err);
            });
    }

    shouldShowCustomPrompt() {
        if (this.alwaysShowCustomPrompt) return true;
        return !!(this.promptConfig && this.promptConfig.force_all_browsers === true);
    }

    isPushSupported() {
        if (!('serviceWorker' in navigator)) {
            return false;
        }
        if (!('PushManager' in window)) {
            return false;
        }
        if (!('showNotification' in ServiceWorkerRegistration.prototype)) {
            return false;
        }
        return true;
    }


    // Use the cached VAPID key/prompt config when we have a fresh copy for
    // this exact channel; otherwise fetch it from the server. This is what
    // spares the network round-trip (preflight + GET) on repeat page loads.
    ensureVapidKey() {
        return this.loadVapidFromCache().then(hit => hit ? null : this.fetchVapidKey());
    }

    async loadVapidFromCache() {
        const creds = await this.readCredentials();

        if (!creds || !creds.applicationServerKey) {
            return false;
        }

        // Scope the cache to this channel: multiple channels can share an
        // origin, and we must never hand channel A's key to channel B.
        if (creds.vapidChannelToken !== this.channelToken) {
            return false;
        }

        if (!creds.vapidFetchedAt || (Date.now() - creds.vapidFetchedAt) >= this.vapidCacheTtlMs) {
            return false;
        }

        this.applicationServerKey = creds.applicationServerKey;
        this.promptConfig = creds.promptConfig || null;
        return true;
    }

    // Drop the cached VAPID key so the next page load refetches it. Called
    // when a subscribe() fails, as a self-healing guard against a stale key
    // (theoretical, since keys never rotate, but free insurance).
    invalidateVapidCache() {
        return this.storeCredentials({vapidFetchedAt: null});
    }

    fetchVapidKey() {
        return fetch(`https://app.allinbox.com/webpush/api/channels/vapid`, {
            headers: {
                'Authorization': `Bearer ${this.channelToken}`,
                'Accept': 'application/json'
            }
        })
            .then(response => {
                if (!response.ok) throw new Error('Unable to fetch public key');
                return response.json();
            })
            .then(data => {
                if (!data.publicKey) throw new Error('Missing public key in response');
                this.applicationServerKey = data.publicKey;
                this.promptConfig = data.promptConfig || null;
                return this.storeCredentials({
                    applicationServerKey: this.applicationServerKey,
                    promptConfig: this.promptConfig,
                    vapidChannelToken: this.channelToken,
                    vapidFetchedAt: Date.now(),
                });
            })
            .catch(err => {
                console.error('[AIB SDK] Error while fetching public key:', err);
            });
    }

    async storeCredentials(fields = {}) {
        if (!('indexedDB' in self) || !this.credentialsKey) return;

        const existing = await this.readCredentials() || {};
        const merged = {
            applicationServerKey: this.applicationServerKey,
            ...existing,
            ...fields,
            // Always the channel of this page: the worker re-subscribes with
            // this token when the browser rotates the subscription.
            channelToken: this.channelToken,
        };

        return new Promise(resolve => {
            let req;
            try {
                req = indexedDB.open('aib-webpush-sdk', 1);
            } catch (_) {
                return resolve();
            }

            req.onupgradeneeded = () => req.result.createObjectStore('credentials');
            req.onerror = () => resolve();
            req.onsuccess = () => {
                const db = req.result;
                try {
                    const tx = db.transaction('credentials', 'readwrite');
                    tx.objectStore('credentials').put(merged, this.credentialsKey);
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.onerror = () => { db.close(); resolve(); };
                } catch (_) {
                    db.close();
                    resolve();
                }
            };
        });
    }

    async readCredentials() {
        if (!this.credentialsKey) return null;

        const record = await this.readCredentialsRecords(store => store.get(this.credentialsKey));
        if (record) return record;

        // Until October 2026 every channel of an origin shared one record,
        // stored under "current". Take it over only when it belongs to this
        // channel, which is always the case on a single-channel site; the next
        // write moves it under this channel's own key.
        const legacy = await this.readCredentialsRecords(store => store.get('current'));
        return legacy && legacy.channelToken === this.channelToken ? legacy : null;
    }

    // True when the origin holds the state of another channel: that channel
    // may have obtained the notification permission this page now sees.
    async hasAnotherChannelOnOrigin() {
        const records = await this.readCredentialsRecords(store => store.getAll()) || [];
        return records.some(record => record && record.channelToken && record.channelToken !== this.channelToken);
    }

    readCredentialsRecords(query) {
        if (!('indexedDB' in self)) return Promise.resolve(null);

        return new Promise(resolve => {
            let req;
            try {
                req = indexedDB.open('aib-webpush-sdk', 1);
            } catch (_) {
                return resolve(null);
            }

            req.onupgradeneeded = () => req.result.createObjectStore('credentials');
            req.onerror = () => resolve(null);
            req.onsuccess = () => {
                const db = req.result;
                try {
                    const tx = db.transaction('credentials', 'readonly');
                    const getReq = query(tx.objectStore('credentials'));
                    getReq.onsuccess = () => { db.close(); resolve(getReq.result || null); };
                    getReq.onerror = () => { db.close(); resolve(null); };
                } catch (_) {
                    db.close();
                    resolve(null);
                }
            };
        });
    }

    requestPermission() {
        let userConsentPromise = Promise.resolve(true);
        if (this.shouldShowCustomPrompt()) {
            userConsentPromise = this.showCustomNotificationPrompt();
        }

        return userConsentPromise
            .then(userAccepted => {
                if (!userAccepted) {
                    return null;
                }

                return Notification.requestPermission();
            })
            .then(permission => {
                if (permission !== 'granted') {
                    return null;
                }

                return navigator.serviceWorker.ready;
            })
            .then(swRegistration => {
                if (!swRegistration) return null;

                return swRegistration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: this.urlBase64ToUint8Array(this.applicationServerKey),
                });
            })
            .catch(err => {
                // A subscribe failure is the symptom of a stale cached key:
                // drop it so the next page load refetches a fresh one.
                this.invalidateVapidCache();
                console.error('[AIB SDK] Error during request permission', err);
            });
    }

    sendSubscriptionToServer(subscription, method) {
        const key = subscription.getKey('p256dh');
        const token = subscription.getKey('auth');
        const contentEncoding = (PushManager.supportedContentEncodings || ['aesgcm'])[0];
        const userAgent = navigator.userAgent;

        return fetch(`https://app.allinbox.com/webpush/api/channels/subscription`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.channelToken}`,
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                endpoint: subscription.endpoint,
                publicKey: key ? btoa(String.fromCharCode.apply(null, new Uint8Array(key))) : null,
                authToken: token ? btoa(String.fromCharCode.apply(null, new Uint8Array(token))) : null,
                contentEncoding,
                userAgent,
                subscriberId: this.subscriberId || null,
            }),
        }).then(response => {
            if (response && response.ok) {
                // Remember the endpoint so we can detect unsubscription on
                // later visits (native Chrome "Unsubscribe" doesn't fire any
                // SW event) and clean up the backend pro-actively. The date
                // records that the visitor agreed to this channel once.
                this.storeCredentials({endpoint: subscription.endpoint, subscribedAt: Date.now()});
            }
            return response;
        });
    }

    deleteSubscriptionOnServer(endpoint) {
        return fetch(`https://app.allinbox.com/webpush/api/channels/subscription`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.channelToken}`,
                'Accept': 'application/json',
            },
            body: JSON.stringify({endpoint}),
        }).catch(err => {
            console.error('[AIB SDK] subscription DELETE failed:', err);
        });
    }

    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    showCustomNotificationPrompt() {
        return new Promise(resolve => {
            const config = this.promptConfig || {};
            const sanitizeInt = (val, fallback, min, max) => { const n = parseInt(val); return (!isNaN(n) && n >= min && n <= max) ? n : fallback; };
            const delay = sanitizeInt(config.delay, 0, 0, 60) * 1000;

            const show = () => {
            const labels = this.translations[this.lang] || this.translations.fr;

            const sanitizeCSS = (val) => val ? val.replace(/[;<>{}]/g, '') : '';
            const sanitizeColor = (val, fallback) => /^#[0-9a-fA-F]{3,8}$/.test(val) ? val : fallback;
            const sanitizeUrl = (val) => val && /^https?:\/\//i.test(val) ? val : '';

            const title = config.title || labels.title;
            const text = config.text || labels.text;
            const allowText = config.allow_text || labels.allow;
            const denyText = config.deny_text || labels.deny;
            const fontFamily = sanitizeCSS(config.font_family) || 'inherit, Arial, sans-serif';
            const bgColor = sanitizeColor(config.bg_color, '#ffffff');
            const buttonColor = sanitizeColor(config.button_color, '#337ab7');
            const titleFontSize = sanitizeInt(config.title_font_size, 14, 10, 48) + 'px';
            const textFontSize = sanitizeInt(config.text_font_size, 14, 10, 48) + 'px';
            const buttonFontSize = sanitizeInt(config.button_font_size, 14, 10, 48) + 'px';
            const buttonPadding = sanitizeInt(config.button_padding, 6, 0, 40);
            const modalWidth = sanitizeInt(config.modal_width, 320, 200, 800) + 'px';
            const modalHeight = config.modal_height ? sanitizeInt(config.modal_height, 0, 0, 600) + 'px' : 'auto';
            const modalPadding = sanitizeInt(config.modal_padding, 16, 0, 60);
            const buttonRadius = sanitizeInt(config.button_radius, 0, 0, 50) + 'px';
            const borderRadius = sanitizeInt(config.border_radius, 2, 0, 50) + 'px';
            const logo = sanitizeUrl(config.logo);
            const logoSize = sanitizeInt(config.logo_size, 40, 20, 150) + 'px';
            const logoPosition = config.logo_position || 'left';
            const position = config.position || 'bottom-left';
            const animation = config.animation || '';

            const positionStyles = {
                'bottom-left':   { bottom: '20px', left: '20px' },
                'bottom-center': { bottom: '20px', left: '0', right: '0', marginLeft: 'auto', marginRight: 'auto' },
                'bottom-right':  { bottom: '20px', right: '20px' },
                'top-left':      { top: '20px', left: '20px' },
                'top-center':    { top: '20px', left: '0', right: '0', marginLeft: 'auto', marginRight: 'auto' },
                'top-right':     { top: '20px', right: '20px' },
                'center':        { top: '0', bottom: '0', left: '0', right: '0', margin: 'auto', height: 'max-content' },
            };

            const container = document.createElement('div');
            Object.assign(container.style, {
                position: 'fixed',
                zIndex: '9999',
                fontFamily: fontFamily,
                width: 'max-content',
                maxWidth: 'calc(100vw - 20px)',
                ...(positionStyles[position] || positionStyles['bottom-left']),
            });

            const box = document.createElement('div');
            box.setAttribute('style', `
                background-color: ${bgColor} !important;
                border: 1px solid #ccc !important;
                border-radius: ${borderRadius} !important;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2) !important;
                box-sizing: border-box !important;
                width: min(${modalWidth}, calc(100vw - 20px)) !important;
                min-height: ${modalHeight} !important;
                padding: ${modalPadding}px ${Math.round(modalPadding * 1.25)}px !important;
                color: #000 !important;
                display: flex !important;
                flex-direction: column !important;
                justify-content: space-between !important;
            `);

            const el = (tag, styles, textOrChildren) => {
                const node = document.createElement(tag);
                if (styles) node.setAttribute('style', styles);
                if (typeof textOrChildren === 'string') node.textContent = textOrChildren;
                else if (Array.isArray(textOrChildren)) textOrChildren.forEach(c => { if (c) node.appendChild(c); });
                return node;
            };

            let logoEl = null;
            if (logo) {
                logoEl = document.createElement('img');
                logoEl.src = logo;
                logoEl.setAttribute('style', `width:${logoSize}!important;height:auto!important;border-radius:6px!important;object-fit:contain!important;flex-shrink:0!important;`);
            }

            const titleEl = el('p', `margin:0 0 8px 0!important;font-weight:bold!important;font-size:${titleFontSize}!important;`, title);
            const textEl = el('p', `margin:0 0 16px 0!important;font-size:${textFontSize}!important;`, text);
            const textWrapper = el('div', 'flex:1!important;', [titleEl, textEl]);

            const contentRow = el('div', `display:flex!important;gap:10px!important;flex-direction:${logoPosition === 'right' ? 'row-reverse' : 'row'}!important;align-items:flex-start!important;`, [logoEl, textWrapper]);

            const denyBtn = el('button', `background:none!important;border:none!important;color:#666!important;font-weight:bold!important;font-size:${buttonFontSize}!important;margin:0!important;margin-right:10px!important;padding:${buttonPadding}px ${buttonPadding * 2}px!important;cursor:pointer!important;transition:background-color 0.2s ease,color 0.2s ease!important;`, denyText);
            const allowBtn = el('button', `background-color:${buttonColor}!important;border:none!important;color:#fff!important;font-weight:bold!important;font-size:${buttonFontSize}!important;margin:0!important;padding:${buttonPadding}px ${buttonPadding * 2}px!important;border-radius:${buttonRadius}!important;cursor:pointer!important;transition:background-color 0.2s ease!important;`, allowText);

            const buttonHoverColor = sanitizeColor(config.button_hover_color, '');
            if (buttonHoverColor) {
                allowBtn.addEventListener('mouseenter', () => { allowBtn.style.setProperty('background-color', buttonHoverColor, 'important'); });
                allowBtn.addEventListener('mouseleave', () => { allowBtn.style.setProperty('background-color', buttonColor, 'important'); });
            }

            const footer = el('div', 'text-align:right!important;', [denyBtn, allowBtn]);

            box.appendChild(contentRow);
            box.appendChild(footer);

            container.appendChild(box);

            if (animation) {
                container.style.opacity = '0';
                const slide = { 'slideUp': 'translateY(30px)', 'slideDown': 'translateY(-30px)' };
                if (slide[animation]) container.style.transform = slide[animation];
                document.body.appendChild(container);
                container.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    container.style.opacity = '1';
                    container.style.transform = '';
                }));
            } else {
                document.body.appendChild(container);
            }

            allowBtn.addEventListener('click', () => {
                document.body.removeChild(container);
                localStorage.removeItem(this.storageKey('declined_at'));
                // Mark "user engaged with the custom popup" so we don't re-show
                // it on every page nav when the native prompt that follows
                // gets dismissed / silently fails (browser anti-spam, closed
                // tab, subscribe() rejection). Cooldown matches the decline
                // window — they've made their choice for now.
                localStorage.setItem(this.storageKey('engaged_at'), new Date().toISOString());
                resolve(true);
            });

            denyBtn.addEventListener('click', () => {
                document.body.removeChild(container);
                localStorage.setItem(this.storageKey('declined_at'), new Date().toISOString());
                resolve(false);
            });
            };

            if (delay > 0) { setTimeout(show, delay); } else { show(); }
        });
    }


    /**
     * Per-channel localStorage key. Multiple Showcase pages (or any other
     * multi-channel host) can sit on the same origin and share one
     * localStorage; without channel scoping, a decline / engagement on
     * Showcase A would silently suppress the popup on Showcase B, which
     * has its own notification channel and deserves its own consent state.
     */
    storageKey(suffix) {
        return `aib_notifications_${suffix}_${this.channelToken}`;
    }

    hasUserDeclinedCustomNotificationPrompt() {
        const declinedAt = localStorage.getItem(this.storageKey('declined_at'));

        if (!declinedAt) return false;

        const declineExpiryDays = 7;
        const declinedTime = new Date(declinedAt).getTime();
        const now = Date.now();

        return (now - declinedTime) <= declineExpiryDays * 24 * 60 * 60 * 1000;
    }

    /**
     * True when the user clicked "Allow" on our custom popup recently. Used
     * to suppress re-prompts when the subsequent native flow didn't conclude
     * with a granted permission + subscription (dismissed, browser anti-spam,
     * subscribe() rejection). Without this, the popup re-fires on every page
     * navigation, which is what users perceive as "my consent isn't saved".
     */
    hasUserRecentlyEngagedWithCustomPrompt() {
        const engagedAt = localStorage.getItem(this.storageKey('engaged_at'));

        if (!engagedAt) return false;

        const engageExpiryDays = 7;
        const engagedTime = new Date(engagedAt).getTime();
        const now = Date.now();

        return (now - engagedTime) <= engageExpiryDays * 24 * 60 * 60 * 1000;
    }
}

// === INITIALIZATION === //
(() => {
    'use strict';

    const currentScript = document.currentScript || document.querySelector('script[data-aib-token]');
    if (!currentScript) {
        return;
    }

    const channelToken = currentScript.getAttribute('data-aib-token');
    if (!channelToken) {
        return;
    }

    const subscriberId = currentScript.getAttribute('data-aib-subscriber-id') || null;
    const lang = document.documentElement.lang || navigator.language.split('-')[0] || 'fr';
    const swPath = currentScript.getAttribute('data-sw-path') || '/AIBSDKWorker.js';
    const swScope = currentScript.getAttribute('data-sw-scope') || '/';

    const pushSubscriptionManager = new PushSubscriptionManager(channelToken, subscriberId, lang, swPath, swScope);
    pushSubscriptionManager.init();
})();