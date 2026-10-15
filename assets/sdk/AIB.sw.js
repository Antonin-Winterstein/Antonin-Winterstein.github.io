// === CLASS DEFINITION === //
class PushNotificationManager {
    constructor() {
    }

    init() {
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

        self.addEventListener('push', this.handlePush.bind(this));
        self.addEventListener('notificationclick', this.handleClick.bind(this));
        self.addEventListener('notificationclose', this.handleClose.bind(this));
        self.addEventListener('pushsubscriptionchange', event => event.waitUntil(this.handleSubscriptionChange(event)));
    }

    /**
     * Fired when the browser rotates or revokes the push subscription
     * (automatic endpoint rotation, user changed permission, etc.).
     * Re-subscribe transparently and update the backend so the subscriber
     * isn't silently lost — forwarding the old endpoint so the server can
     * update the existing row in place and preserve its contact link.
     *
     * @param {ExtendableEvent} event
     */
    async handleSubscriptionChange(event) {
        const creds = await this.readCredentials();
        if (!creds || !creds.channelToken) {
            return;
        }

        // A page that only refreshed an existing subscription never loaded the
        // VAPID key, so the record may lack it: ask the server for it here,
        // on this rare event, rather than on every page load.
        const applicationServerKey = creds.applicationServerKey || await this.fetchApplicationServerKey(creds.channelToken);
        if (!applicationServerKey) {
            return;
        }

        const oldEndpoint = (event && event.oldSubscription && event.oldSubscription.endpoint) || null;

        let newSubscription;
        try {
            newSubscription = await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: this.urlBase64ToUint8Array(applicationServerKey),
            });
        } catch (err) {
            console.error('[AIB SW] re-subscribe failed, treating as revocation:', err);
            if (oldEndpoint) {
                try {
                    await fetch('https://app.allinbox.com/webpush/api/channels/subscription', {
                        method: 'DELETE',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${creds.channelToken}`,
                            'Accept': 'application/json',
                        },
                        body: JSON.stringify({endpoint: oldEndpoint}),
                    });
                } catch (delErr) {
                    console.error('[AIB SW] subscription DELETE failed:', delErr);
                }
            }
            return;
        }

        const key = newSubscription.getKey('p256dh');
        const token = newSubscription.getKey('auth');
        const contentEncoding = ((self.PushManager && self.PushManager.supportedContentEncodings) || ['aesgcm'])[0];

        try {
            await fetch('https://app.allinbox.com/webpush/api/channels/subscription', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${creds.channelToken}`,
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    endpoint: newSubscription.endpoint,
                    oldEndpoint,
                    publicKey: key ? btoa(String.fromCharCode.apply(null, new Uint8Array(key))) : null,
                    authToken: token ? btoa(String.fromCharCode.apply(null, new Uint8Array(token))) : null,
                    contentEncoding,
                    userAgent: (self.navigator && self.navigator.userAgent) || '',
                }),
            });
        } catch (err) {
            console.error('[AIB SW] subscription rotate PUT failed:', err);
        }
    }

    fetchApplicationServerKey(channelToken) {
        return fetch('https://app.allinbox.com/webpush/api/channels/vapid', {
            headers: {
                'Authorization': `Bearer ${channelToken}`,
                'Accept': 'application/json',
            },
        })
            .then(response => response.ok ? response.json() : null)
            .then(data => (data && data.publicKey) || null)
            .catch(err => {
                console.error('[AIB SW] public key fetch failed:', err);
                return null;
            });
    }

    /**
     * State of this worker's channel, written by the SDK under the worker's
     * scope: several channels of one origin each have their own worker and
     * their own record. A page that has not run the current SDK yet only has
     * the former record shared by the whole origin, stored under "current".
     */
    async readCredentials() {
        const record = await this.readCredentialsRecord(`scope:${self.registration.scope}`);

        return record || this.readCredentialsRecord('current');
    }

    readCredentialsRecord(key) {
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
                    const getReq = tx.objectStore('credentials').get(key);
                    getReq.onsuccess = () => { db.close(); resolve(getReq.result || null); };
                    getReq.onerror = () => { db.close(); resolve(null); };
                } catch (_) {
                    db.close();
                    resolve(null);
                }
            };
        });
    }

    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    /**
     * Handle notification push event.
     *
     * https://developer.mozilla.org/en-US/docs/Web/Events/push
     *
     * @param {NotificationEvent} event
     */
    handlePush(event) {
        if (!(self.Notification && self.Notification.permission === 'granted')) {
            return;
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/PushMessageData
        if (event.data) {
            event.waitUntil(
                this.sendNotification(event)
            );
        }
    }

    /**
     * Send notification to the user.
     *
     * https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification
     *
     * @param {NotificationEvent} event
     */
    sendNotification(event) {
        const data = event.data.json();

        const title = data.title || 'Notification';
        const actions = Array.isArray(data.actions) ? data.actions.slice(0, 2) : [];
        const options = {
            body: data.body || '',
            requireInteraction: true,
            icon: data.icon || null,
            image: data.image || null,
            data: {
                url: data.url || null,
                token: data.token || null,
                actions: actions,
            },
        };

        // Action buttons are displayed on Chrome/Edge/Chromium Android only;
        // Firefox and Safari ignore the `actions` option without warning.
        if (actions.length > 0) {
            options.actions = actions.map(a => ({action: a.id, title: a.title}));
        }

        const showPromise = self.registration.showNotification(title, options);

        const shownEvent = this.sendEventToServer(data.token, Date.now(), 'shown');

        return Promise.all([showPromise, shownEvent]);
    }

    /**
     * Handle notification click event.
     *
     * https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclick_event
     *
     * @param {NotificationEvent} event
     */
    handleClick(event) {
        if (event.notification) {
            event.waitUntil(
                this.processClickAction(event)
            );
        }
    }

    /**
     * Process notification click action.
     *
     * @param {NotificationEvent} event
     */
    processClickAction(event) {
        const notification = event.notification;
        const data = notification.data || {};
        const timestamp = Date.now();

        let url = data.url || '/';
        let actionId = null;

        // event.action is set when the user clicked a specific action button;
        // otherwise they clicked the notification body → fall back to data.url.
        if (event.action) {
            const actions = Array.isArray(data.actions) ? data.actions : [];
            const matched = actions.find(a => a && a.id === event.action);
            if (matched) {
                url = matched.url || url;
                actionId = matched.id;
            }
        }

        event.notification.close(); // Android needs explicit close

        const openOrFocusPromise = self.clients.matchAll({type: 'window', includeUncontrolled: true})
            .then(windowClients => {
                const normalize = u => u.replace(/\/$/, '');
                const originOf = u => { try { return new URL(u).origin; } catch (_) { return null; } };
                const targetOrigin = originOf(url);

                const openNewWindow = () => self.clients.openWindow ? self.clients.openWindow(url) : null;

                // 1st pass: exact URL match → just focus.
                const exactClient = windowClients.find(c => normalize(c.url) === normalize(url) && 'focus' in c);
                if (exactClient) {
                    return exactClient.focus();
                }

                // 2nd pass: same-origin tab → navigate it to the new URL instead of opening another one.
                const sameOriginClient = targetOrigin ? windowClients.find(c => originOf(c.url) === targetOrigin && 'navigate' in c) : null;
                if (sameOriginClient) {
                    return sameOriginClient.navigate(url)
                        .then(c => (c && 'focus' in c) ? c.focus() : c)
                        .catch(openNewWindow);
                }

                // Fallback: open a new window/tab.
                return openNewWindow();
            });

        const clickTrackingPromise = this.sendEventToServer(data.token, timestamp, 'clicked', actionId);

        return Promise.all([openOrFocusPromise, clickTrackingPromise]);
    }

    /**
     * Handle notification close event (Chrome 50+, Firefox 55+).
     *
     * https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclose_event
     *
     * @param {NotificationEvent} event
     */
    handleClose(event) {
        if (event.notification) {
            event.waitUntil(
                this.dismissNotification(event)
            );
        }
    }

    /**
     * Send request to server to dismiss a notification.
     *
     * @param  {NotificationEvent} event
     */
    dismissNotification(event) {
        const notification = event.notification;
        const data = notification.data || {};
        const timestamp = Date.now();

        return this.sendEventToServer(data.token, timestamp, 'dismissed');
    }

    /**
     * Send an interaction event (shown, clicked, dismissed) to the server.
     *
     * @param {String|Number} token
     * @param {Number} timestamp
     * @param {String} eventType - 'shown', 'clicked', 'dismissed'
     * @param {String|null} action - action button id (e.g. 'cta_primary') when the
     *                               click originated from an action button, else null
     */
    sendEventToServer(token, timestamp, eventType, action = null) {
        if (!token) {
            return Promise.resolve();
        }

        return self.registration.pushManager.getSubscription().then(subscription => {
            if (!subscription || !subscription.endpoint) {
                return;
            }

            const payload = {
                event: eventType,
                token: token,
                endpoint: subscription.endpoint,
                timestamp: String(timestamp),
            };

            if (action) {
                payload.action = action;
            }

            return fetch('https://wkmg1177m0.execute-api.eu-west-3.amazonaws.com/production/webpush_events', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload),
            });
        }).catch(err => {
            console.error('[AIB SW] Event sending error:', err);
        });
    }
}

// === INITIALIZATION === //
(() => {
    'use strict';

    const pushNotificationManager = new PushNotificationManager();
    pushNotificationManager.init();
})();