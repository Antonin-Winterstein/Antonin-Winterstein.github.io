// Shows what the browser holds for the whole domain: the notification
// permission (one per domain) and, for the network and each city, its
// service worker and its push subscription (one per scope).
(() => {
    'use strict';

    // "of", "for" and "page" keep the French sentences below grammatical.
    const CITIES = [
        {name: 'Réseau', scope: '/', of: 'du réseau', for: 'le réseau', page: "l'accueil"},
        {name: 'Paris', scope: '/paris/', of: 'de Paris', for: 'Paris', page: 'la page de Paris'},
        {name: 'Rome', scope: '/rome/', of: 'de Rome', for: 'Rome', page: 'la page de Rome'},
        {name: 'Berlin', scope: '/berlin/', of: 'de Berlin', for: 'Berlin', page: 'la page de Berlin'},
    ];

    const PERMISSIONS = {
        granted: 'accordée',
        denied: 'refusée',
        default: 'pas encore demandée',
    };

    const panel = document.querySelector('[data-push-panel]');

    if (!panel) {
        return;
    }

    const currentScope = panel.getAttribute('data-current-scope');
    const permissionEl = panel.querySelector('[data-push-permission]');
    const standsEl = panel.querySelector('[data-push-stands]');
    const refreshButton = panel.querySelector('[data-push-refresh]');

    const isSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

    async function readStands() {
        const registrations = await navigator.serviceWorker.getRegistrations();

        return Promise.all(CITIES.map(async (city) => {
            const scopeUrl = new URL(city.scope, location.origin).href;
            const registration = registrations.find((r) => r.scope === scopeUrl);

            if (!registration) {
                return {city, state: 'none'};
            }

            const subscription = await registration.pushManager.getSubscription();

            return subscription
                ? {city, state: 'subscribed', endpoint: subscription.endpoint}
                : {city, state: 'worker'};
        }));
    }

    function describe(stand) {
        const city = stand.city;

        if (stand.state === 'subscribed') {
            const url = new URL(stand.endpoint);

            return `Le navigateur est abonné. L'adresse d'abonnement chez ${url.host} se termine par ${stand.endpoint.slice(-10)}.`;
        }

        if (stand.state === 'worker') {
            return `Le worker ${city.of} est enregistré sur ${city.scope}, mais le navigateur n'a pas d'abonnement.`;
        }

        if (city.scope !== currentScope) {
            return `Le navigateur n'a pas de worker pour ${city.for}. Ouvrez ${city.page} pour en enregistrer un.`;
        }

        // The SDK stops before registering anything once notifications are blocked.
        if (Notification.permission === 'denied') {
            return `Le navigateur n'a pas de worker pour ${city.for}. Le SDK n'en enregistre pas, parce que les notifications sont refusées.`;
        }

        return `Le navigateur n'a pas encore de worker pour ${city.for}. Le SDK l'enregistre au chargement de cette page.`;
    }

    function renderStand(stand) {
        const item = document.createElement('li');
        item.className = 'stand';
        item.dataset.state = stand.state;

        const light = document.createElement('span');
        light.className = 'stand-light';
        light.setAttribute('aria-hidden', 'true');

        const name = document.createElement('span');
        name.className = 'stand-name';
        name.textContent = stand.city.name;

        if (stand.city.scope === currentScope) {
            const here = document.createElement('small');
            here.textContent = 'cette page';
            name.append(here);
        }

        const detail = document.createElement('span');
        detail.className = 'stand-detail';
        detail.textContent = describe(stand);

        item.append(light, name, detail);

        return item;
    }

    async function render() {
        if (!isSupported) {
            permissionEl.textContent = 'Ce navigateur ne gère pas les notifications push.';
            refreshButton.hidden = true;

            return;
        }

        permissionEl.replaceChildren(
            'Autorisation du navigateur pour tout le domaine : ',
            Object.assign(document.createElement('strong'), {
                textContent: PERMISSIONS[Notification.permission] || Notification.permission,
            }),
            '.'
        );

        try {
            const stands = await readStands();
            standsEl.replaceChildren(...stands.map(renderStand));
        } catch (error) {
            // Service workers only run over HTTPS (or localhost): a file:// or
            // plain HTTP copy of the page lands here.
            const item = document.createElement('li');
            item.className = 'stand';
            item.textContent = `Le navigateur refuse les workers sur cette page (${error.name}). Ouvrez-la en HTTPS.`;
            standsEl.replaceChildren(item);
        }
    }

    refreshButton.addEventListener('click', render);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            render();
        }
    });

    render();

    // The SDK registers the worker and subscribes a few seconds after the page
    // loads, and the visitor may take a while to answer the browser prompt.
    // Re-read the state every 2 seconds during the first minute.
    let ticks = 0;
    const timer = setInterval(() => {
        render();
        ticks += 1;

        if (ticks >= 30) {
            clearInterval(timer);
        }
    }, 2000);
})();
