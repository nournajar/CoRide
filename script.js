// ===== Connexion au serveur CoRide =====
// Le serveur doit tourner en local (npm run dev) pour que cette page fonctionne.
const API_BASE = 'http://localhost:4000/api';

let authToken = null;   // en mémoire uniquement : perdu si la page est rechargée
let currentUser = null;
let trajets = [];

// ===== Stripe Elements =====
let stripeInstance = null;
let stripeCardElement = null;
let stripeReady = false;

async function initStripe(){
  if(stripeReady) return;
  try {
    const res = await fetch(API_BASE + '/config');
    const config = await res.json();
    if(!config.stripePublishableKey || config.stripePublishableKey.includes('...')) return;

    stripeInstance = Stripe(config.stripePublishableKey);
    const elements = stripeInstance.elements();
    stripeCardElement = elements.create('card', {
      hidePostalCode: true,
      style: { base: { color: '#F4F2EC', fontSize: '15px', '::placeholder': { color: 'rgba(244,242,236,0.45)' } }, invalid: { color: '#c1443c' } },
    });
    stripeCardElement.mount('#stripe-card-element');
    stripeCardElement.on('change', (event) => {
      document.getElementById('stripe-card-errors').textContent = event.error ? event.error.message : '';
    });
    stripeReady = true;
  } catch (err) {
    console.error('Stripe init error', err);
  }
}

// ===== Messagerie temps réelle =====
let chatSocket = null;
let currentChatTrajetId = null;

// ===== Connexion globale (pour recevoir les notifications même sans avoir
// un chat ouvert) =====
let globalSocket = null;
let unreadByTrajet = {}; // { trajetId: { count, villeDepart, villeArrivee, expediteurNom, contenu } }

function connectGlobalSocket(){
  if(globalSocket) return;
  globalSocket = io('http://localhost:4000', { auth: { token: authToken } });

  globalSocket.on('message_notification', (notif) => {
    // Si cette conversation est déjà ouverte à l'écran, pas besoin de la
    // signaler en plus : le message apparaît déjà en direct dans le chat.
    const chatIsOpenForThisTrajet =
      document.getElementById('chat-overlay').classList.contains('open') &&
      currentChatTrajetId === notif.trajetId;
    if(chatIsOpenForThisTrajet) return;

    const prev = unreadByTrajet[notif.trajetId];
    unreadByTrajet[notif.trajetId] = {
      count: prev ? prev.count + 1 : 1,
      villeDepart: notif.villeDepart,
      villeArrivee: notif.villeArrivee,
      expediteurNom: notif.expediteurNom,
      contenu: notif.contenu,
    };
    renderNotifBubble();
  });
}

function disconnectGlobalSocket(){
  if(globalSocket){ globalSocket.disconnect(); globalSocket = null; }
  unreadByTrajet = {};
  renderNotifBubble();
}

function renderNotifBubble(){
  const entries = Object.entries(unreadByTrajet);
  const totalCount = entries.reduce((sum, [, v]) => sum + v.count, 0);
  const bubble = document.getElementById('notif-bubble');
  const countEl = document.getElementById('notif-count');

  bubble.classList.toggle('visible', totalCount > 0);
  countEl.style.display = totalCount > 0 ? 'flex' : 'none';
  countEl.textContent = totalCount > 9 ? '9+' : totalCount;

  const list = document.getElementById('notif-list');
  if(entries.length === 0){
    list.innerHTML = '<div class="notif-item" style="opacity:0.6; cursor:default;">Aucun nouveau message</div>';
    return;
  }

  list.innerHTML = entries.map(([trajetId, v]) => `
    <div class="notif-item" data-trajetid="${trajetId}">
      <div class="notif-route">${v.villeDepart} → ${v.villeArrivee}</div>
      <div class="notif-from">${v.expediteurNom}<span class="notif-badge-count">${v.count}</span></div>
      <div class="notif-preview">${v.contenu}</div>
    </div>
  `).join('');

  document.querySelectorAll('.notif-item[data-trajetid]').forEach(item => {
    item.addEventListener('click', () => openChatFromNotif(item.dataset.trajetid));
  });
}

function openChatFromNotif(trajetId){
  const notif = unreadByTrajet[trajetId];
  if(!notif) return;

  document.getElementById('notif-panel').classList.remove('open');
  document.getElementById('chat-name').textContent = notif.expediteurNom;
  document.getElementById('chat-initial').textContent = notif.expediteurNom.charAt(0).toUpperCase();
  currentChatTrajetId = trajetId;
  document.getElementById('chat-overlay').classList.add('open');
  connectChat(trajetId);

  delete unreadByTrajet[trajetId];
  renderNotifBubble();
}

document.getElementById('notif-bubble').addEventListener('click', () => {
  document.getElementById('notif-panel').classList.toggle('open');
});

// Coordonnées connues pour les trajets publiés (à remplacer par un vrai
// géocodage — Google Maps/Mapbox — quand ces API seront branchées)
const VILLE_COORDS = {
  'tunis': { lat: 36.8065, lng: 10.1815 },
  'sousse': { lat: 35.8256, lng: 10.6084 },
  'sfax': { lat: 34.7406, lng: 10.7603 },
  'bizerte': { lat: 37.2744, lng: 9.8739 },
  'gabès': { lat: 33.8815, lng: 10.0982 },
  'gabes': { lat: 33.8815, lng: 10.0982 },
};

async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;

  let res;
  try {
    res = await fetch(API_BASE + path, { ...options, headers });
  } catch (err) {
    throw new Error("Impossible de contacter le serveur. Vérifie qu'il tourne bien sur ton ordinateur (npm run dev).");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Une erreur est survenue.');
  return data;
}

function requireLogin() {
  if (!authToken) {
    alert('Connectez-vous ou créez un compte pour effectuer cette action.');
    return false;
  }
  return true;
}

// Backend trajet -> forme attendue par l'affichage frontend
function mapTrajet(t) {
  const dt = new Date(t.dateHeure);
  return {
    id: t.id,
    from: t.villeDepart,
    to: t.villeArrivee,
    date: dt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }),
    time: dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    price: Number(t.prixParPlace),
    seats: t.placesDispo,
    complet: t.complet,
    driver: t.conducteur ? t.conducteur.nom : 'Conducteur',
    rating: 5.0, // le système de notation n'est pas encore branché côté serveur
  };
}

async function loadTrajets(filters = {}) {
  const params = new URLSearchParams();
  if (filters.villeDepart) params.set('villeDepart', filters.villeDepart);
  if (filters.villeArrivee) params.set('villeArrivee', filters.villeArrivee);
  if (filters.date) params.set('date', filters.date);
  if (filters.lat && filters.lng) {
    params.set('lat', filters.lat);
    params.set('lng', filters.lng);
  }

  try {
    const data = await apiFetch('/trajets' + (params.toString() ? '?' + params.toString() : ''));
    trajets = data.trajets.map(mapTrajet);
    render(trajets);
  } catch (err) {
    document.getElementById('trajets-list').innerHTML =
      '<div class="no-results">' + err.message + '</div>';
  }
}

let currentList = trajets;

function render(list){
  currentList = list;
  const container = document.getElementById('trajets-list');
  const count = document.getElementById('results-count');
  count.textContent = list.length + (list.length > 1 ? " trajets" : " trajet");

  if(list.length === 0){
    container.innerHTML = '<div class="no-results">Aucun trajet ne correspond à cette recherche.<br>Essayez une autre ville, ou publiez le vôtre.</div>';
    return;
  }

  container.innerHTML = list.map((t, i) => {
    const low = t.seats <= 1;
    const indisponible = t.complet || t.seats <= 0;
    return `
      <div class="trajet-card" data-index="${i}">
        <div class="trajet-time">${t.time}<span class="date-sub">${t.date}</span></div>
        <div>
          <div class="trajet-route">
            <span class="route-point">${t.from}</span>
            <span class="route-dashes"></span>
            <span class="route-point">${t.to}</span>
          </div>
          <div class="trajet-meta">
            <span>${t.driver} · ★ ${t.rating}</span>
            <button class="contact-btn" data-driver="${t.driver}" data-trajetid="${t.id}" title="Contacter le conducteur">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" stroke="#F4F2EC" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>
        <div class="trajet-right">
          <div class="trajet-price">${t.price} <span>DT</span></div>
          <div class="seats-badge ${(low || indisponible) ? 'low' : ''}">${t.complet ? 'Complet' : t.seats + ' place' + (t.seats>1?'s':'')}</div>
          <button class="reserve-btn" data-index="${i}" ${indisponible ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${indisponible ? 'Complet' : 'Réserver'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.trajet-card').forEach(card => {
    card.addEventListener('click', () => openReservation(parseInt(card.dataset.index)));
  });
  document.querySelectorAll('.reserve-btn').forEach(btn => {
    if(!btn.disabled) btn.addEventListener('click', e => { e.stopPropagation(); openReservation(parseInt(btn.dataset.index)); });
  });
  document.querySelectorAll('.contact-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openContact(btn.dataset.driver, btn.dataset.trajetid); });
  });
}

let reservationTarget = null;
let selectedPaymentMethod = 'especes';

function updateResTotal(){
  if(!reservationTarget) return;
  const seatsInput = document.getElementById('res-seats');
  let val = parseInt(seatsInput.value) || 1;
  if(val < 1) val = 1;
  if(val > reservationTarget.seats) val = reservationTarget.seats;
  seatsInput.value = val;
  document.getElementById('res-total').textContent = (val * reservationTarget.price) + ' DT au total';
}

function openReservation(index){
  const t = currentList[index];
  if(!t || t.seats <= 0 || t.complet) return;
  reservationTarget = t;
  showResFormState();
  document.getElementById('res-summary').innerHTML =
    '<strong>' + t.from + ' → ' + t.to + '</strong><br>' + t.date + ' à ' + t.time + ' · ' + t.driver + ' · ★ ' + t.rating;
  const seatsInput = document.getElementById('res-seats');
  seatsInput.value = 1;
  seatsInput.max = t.seats;
  updateResTotal();
  selectedPaymentMethod = 'especes';
  document.querySelectorAll('.payment-option').forEach(o => o.classList.toggle('selected', o.dataset.method === 'especes'));
  document.getElementById('reservation-overlay').classList.add('open');
}

document.querySelectorAll('.payment-option').forEach(opt => {
  opt.addEventListener('click', () => {
    selectedPaymentMethod = opt.dataset.method;
    document.querySelectorAll('.payment-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    document.getElementById('card-fields').classList.toggle('hidden', selectedPaymentMethod !== 'carte');
    if(selectedPaymentMethod === 'carte') initStripe();
  });
});

document.getElementById('res-minus').addEventListener('click', () => {
  const seatsInput = document.getElementById('res-seats');
  seatsInput.value = (parseInt(seatsInput.value) || 1) - 1;
  updateResTotal();
});
document.getElementById('res-plus').addEventListener('click', () => {
  const seatsInput = document.getElementById('res-seats');
  seatsInput.value = (parseInt(seatsInput.value) || 1) + 1;
  updateResTotal();
});
document.getElementById('res-seats').addEventListener('input', updateResTotal);

document.getElementById('res-cancel').addEventListener('click', () => {
  document.getElementById('reservation-overlay').classList.remove('open');
  reservationTarget = null;
  showResFormState();
});
document.getElementById('reservation-overlay').addEventListener('click', e => {
  if(e.target.id === 'reservation-overlay'){
    document.getElementById('reservation-overlay').classList.remove('open');
    reservationTarget = null;
    showResFormState();
  }
});

function showResFormState(){
  document.getElementById('res-summary').style.display = '';
  document.querySelectorAll('.modal-field').forEach(f => { if(f.closest('#reservation-overlay')) f.style.display = ''; });
  document.getElementById('res-actions').style.display = 'flex';
  document.getElementById('res-loading').style.display = 'none';
  document.getElementById('res-success').style.display = 'none';
}

function showResLoadingState(text){
  document.getElementById('res-summary').style.display = 'none';
  document.querySelectorAll('#reservation-overlay .modal-field').forEach(f => f.style.display = 'none');
  document.getElementById('res-actions').style.display = 'none';
  document.getElementById('res-loading-text').textContent = text;
  document.getElementById('res-loading').style.display = 'block';
  document.getElementById('res-success').style.display = 'none';
}

function showResSuccessState(detail){
  document.getElementById('res-loading').style.display = 'none';
  document.getElementById('res-success-detail').textContent = detail;
  document.getElementById('res-success').style.display = 'block';
}

document.getElementById('res-success-close').addEventListener('click', () => {
  document.getElementById('reservation-overlay').classList.remove('open');
  reservationTarget = null;
  showResFormState();
  loadTrajets();
});

document.getElementById('res-confirm').addEventListener('click', async () => {
  if(!reservationTarget) return;
  if(!requireLogin()) return;
  if(selectedPaymentMethod === 'carte' && !stripeReady){
    alert("Le formulaire de carte n'est pas prêt. Vérifie que le serveur est démarré avec une clé Stripe configurée.");
    return;
  }

  const val = parseInt(document.getElementById('res-seats').value) || 1;
  const from = reservationTarget.from, to = reservationTarget.to;
  const methodeApi = selectedPaymentMethod === 'carte' ? 'CARTE' : 'ESPECES';

  showResLoadingState(methodeApi === 'CARTE' ? 'Traitement du paiement...' : 'Confirmation de la réservation...');

  try {
    const data = await apiFetch('/reservations', {
      method: 'POST',
      body: JSON.stringify({
        trajetId: reservationTarget.id,
        placesReservees: val,
        methodePaiement: methodeApi,
      }),
    });

    let detail;

    if(data.clientSecret){
      showResLoadingState('Confirmation de la carte...');
      // Confirmation réelle du paiement avec la carte saisie via Stripe Elements
      const { error, paymentIntent } = await stripeInstance.confirmCardPayment(data.clientSecret, {
        payment_method: { card: stripeCardElement },
      });
      if(error) throw new Error(error.message);
      detail = 'Paiement par carte confirmé pour ' + from + ' → ' + to + '.';
    } else {
      detail = val + ' place' + (val > 1 ? 's' : '') + ' pour ' + from + ' → ' + to + ', paiement en espèces.';
    }

    showResSuccessState(detail);
  } catch (err) {
    showResFormState();
    alert(err.message);
  }
});

function doSearch(){
  const villeDepart = document.getElementById('input-depart').value.trim();
  const villeArrivee = document.getElementById('input-arrivee').value.trim();
  const date = document.getElementById('input-date').value; // format YYYY-MM-DD natif du calendrier
  loadTrajets({ villeDepart, villeArrivee, date });
}

document.getElementById('btn-search').addEventListener('click', doSearch);
['input-depart','input-arrivee'].forEach(id => {
  document.getElementById(id).addEventListener('keyup', e => { if(e.key === 'Enter') doSearch(); });
});

const overlay = document.getElementById('modal-overlay');
document.getElementById('btn-publier').addEventListener('click', () => overlay.classList.add('open'));
document.getElementById('btn-cancel').addEventListener('click', () => overlay.classList.remove('open'));
overlay.addEventListener('click', e => { if(e.target === overlay) overlay.classList.remove('open'); });

document.getElementById('btn-confirm').addEventListener('click', async () => {
  if(!requireLogin()) return;

  const from = document.getElementById('m-depart').value.trim();
  const to = document.getElementById('m-arrivee').value.trim();
  const date = document.getElementById('m-date').value;         // format YYYY-MM-DD (calendrier natif)
  const time = document.getElementById('m-heure').value.trim();  // ex. "09:00"
  const price = parseFloat(document.getElementById('m-prix').value) || 0;
  const seats = parseInt(document.getElementById('m-places').value) || 1;

  if(!from || !to || !date || !time || price <= 0){
    alert("Merci de remplir tous les champs (départ, arrivée, date, heure, prix).");
    return;
  }

  // Priorité aux coordonnées choisies sur la vraie carte (précises), sinon
  // on retombe sur la petite liste de villes connues codée en dur.
  const depCoords = mapSelectedCoords['input-depart'] || VILLE_COORDS[from.toLowerCase()];
  const arrCoords = mapSelectedCoords['input-arrivee'] || VILLE_COORDS[to.toLowerCase()];
  if(!depCoords || !arrCoords){
    alert("Ville non reconnue. Utilisez l'icône carte 🗺️ à côté du champ pour sélectionner précisément le lieu, ou tapez : Tunis, Sousse, Sfax, Bizerte ou Gabès.");
    return;
  }

  // Combine la date du calendrier (YYYY-MM-DD) et l'heure (HH:MM) en ISO
  const [yyyy, mo, dd] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const dateHeure = new Date(yyyy, mo - 1, dd, hh || 0, mm || 0).toISOString();

  try {
    await apiFetch('/trajets', {
      method: 'POST',
      body: JSON.stringify({
        villeDepart: from,
        villeArrivee: to,
        latDepart: depCoords.lat,
        lngDepart: depCoords.lng,
        latArrivee: arrCoords.lat,
        lngArrivee: arrCoords.lng,
        dateHeure,
        prixParPlace: price,
        placesDispo: seats,
      }),
    });

    overlay.classList.remove('open');
    document.querySelectorAll('#modal-overlay .modal-field input').forEach(i => i.value = '');
    alert('Trajet publié !');
    loadTrajets();
  } catch (err) {
    alert(err.message);
  }
});

const mapOverlay = document.getElementById('map-overlay');
let mapTarget = null;
let leafletMap = null;
let leafletMarker = null;

// Coordonnées choisies sur la vraie carte, par champ ("input-depart" / "input-arrivee")
// — prioritaires sur VILLE_COORDS quand elles existent, pour plus de précision.
const mapSelectedCoords = {};

function initLeafletMap(){
  if(leafletMap) return;
  leafletMap = L.map('leaflet-map', { zoomControl: true }).setView([34.0, 9.5], 6.3);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 18,
  }).addTo(leafletMap);

  leafletMap.on('click', async (e) => {
    await placeMarkerAndReverseGeocode(e.latlng.lat, e.latlng.lng);
  });
}

function placeMarkerOnMap(lat, lng){
  if(leafletMarker) leafletMap.removeLayer(leafletMarker);
  leafletMarker = L.circleMarker([lat, lng], {
    radius: 9, color: '#f4f2ec', weight: 2, fillColor: '#e8a33d', fillOpacity: 1, className: 'coride-marker',
  }).addTo(leafletMap);
}

async function placeMarkerAndReverseGeocode(lat, lng){
  placeMarkerOnMap(lat, lng);
  document.getElementById('map-selected-label').textContent = 'Recherche du lieu...';

  let placeName = lat.toFixed(3) + ', ' + lng.toFixed(3);
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&accept-language=fr');
    const data = await res.json();
    const addr = data.address || {};
    placeName = addr.city || addr.town || addr.village || addr.municipality || addr.county || data.display_name.split(',')[0] || placeName;
  } catch (err) {
    console.error('Reverse geocoding error', err);
  }

  if(mapTarget){
    document.getElementById(mapTarget).value = placeName;
    mapSelectedCoords[mapTarget] = { lat, lng };
  }
  document.getElementById('map-selected-label').textContent = 'Sélectionné : ' + placeName;

  setTimeout(() => {
    mapOverlay.classList.remove('open');
    if(mapTarget === 'input-depart'){
      loadTrajets({ lat, lng });
    }
  }, 500);
}

document.querySelectorAll('.map-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    mapTarget = btn.dataset.target;
    mapOverlay.classList.add('open');
    document.getElementById('map-selected-label').textContent = "Cliquez sur la carte pour choisir un point de départ ou d'arrivée";
    setTimeout(() => {
      initLeafletMap();
      leafletMap.invalidateSize();
    }, 50);
  });
});
document.getElementById('btn-map-cancel').addEventListener('click', () => mapOverlay.classList.remove('open'));
mapOverlay.addEventListener('click', e => { if(e.target === mapOverlay) mapOverlay.classList.remove('open'); });

document.getElementById('btn-geolocate').addEventListener('click', () => {
  if(!navigator.geolocation){
    alert("La géolocalisation n'est pas disponible sur cet appareil.");
    return;
  }
  const btn = document.getElementById('btn-geolocate');
  const original = btn.innerHTML;
  btn.innerHTML = 'Localisation en cours...';
  mapTarget = 'input-depart';

  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude, longitude } = pos.coords;
      btn.innerHTML = original;
      if(leafletMap){
        leafletMap.setView([latitude, longitude], 11);
      }
      await placeMarkerAndReverseGeocode(latitude, longitude);
    },
    () => {
      btn.innerHTML = original;
      alert("Impossible d'accéder à votre position. Vérifiez les autorisations de localisation.");
    }
  );
});

// Menu (hamburger)
const menuOverlay = document.getElementById('menu-overlay');
document.getElementById('btn-menu').addEventListener('click', () => menuOverlay.classList.add('open'));
document.getElementById('btn-menu-cancel').addEventListener('click', () => menuOverlay.classList.remove('open'));
menuOverlay.addEventListener('click', e => { if(e.target === menuOverlay) menuOverlay.classList.remove('open'); });

const tripsOverlay = document.getElementById('trips-history-overlay');
const paymentsOverlay = document.getElementById('payments-history-overlay');

async function loadHistory(){
  if(!requireLogin()) return null;
  try {
    const data = await apiFetch('/reservations/me');
    return data.reservations;
  } catch (err) {
    alert(err.message);
    return null;
  }
}

function formatReservationLine(r){
  const dt = new Date(r.trajet.dateHeure);
  const dateStr = dt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  return '<div style="padding:12px 0; border-bottom:1px solid rgba(244,242,236,0.1);">' +
    '<strong>' + r.trajet.villeDepart + ' → ' + r.trajet.villeArrivee + '</strong> · ' + dateStr +
    '<br><span style="opacity:0.7; font-size:13px;">' + r.placesReservees + ' place(s) · ' + r.montantTotal + ' DT · ' + r.statut + '</span></div>';
}

document.getElementById('menu-trips').addEventListener('click', async () => {
  menuOverlay.classList.remove('open');
  const reservations = await loadHistory();
  if(!reservations) return;
  const container = tripsOverlay.querySelector('.modal');
  const list = reservations.length
    ? reservations.map(formatReservationLine).join('')
    : '<p style="opacity:0.75; font-size:14px;">Vous n\'avez pas encore de trajet effectué.</p>';
  container.innerHTML = '<h3>Historique des trajets</h3>' + list +
    '<div class="modal-actions"><button class="btn-cancel" id="btn-trips-cancel">Fermer</button></div>';
  container.querySelector('#btn-trips-cancel').addEventListener('click', () => tripsOverlay.classList.remove('open'));
  tripsOverlay.classList.add('open');
});
tripsOverlay.addEventListener('click', e => { if(e.target === tripsOverlay) tripsOverlay.classList.remove('open'); });

document.getElementById('menu-payments').addEventListener('click', async () => {
  menuOverlay.classList.remove('open');
  const reservations = await loadHistory();
  if(!reservations) return;
  const container = paymentsOverlay.querySelector('.modal');
  const list = reservations.length
    ? reservations.map(r => '<div style="padding:12px 0; border-bottom:1px solid rgba(244,242,236,0.1);">' +
        '<strong>' + r.montantTotal + ' DT</strong> · ' + r.paiement.methode + ' · ' + r.paiement.statut +
        '<br><span style="opacity:0.7; font-size:13px;">' + r.trajet.villeDepart + ' → ' + r.trajet.villeArrivee + '</span></div>').join('')
    : '<p style="opacity:0.75; font-size:14px;">Aucun paiement pour le moment.</p>';
  container.innerHTML = '<h3>Historique des paiements</h3>' + list +
    '<div class="modal-actions"><button class="btn-cancel" id="btn-payments-cancel">Fermer</button></div>';
  container.querySelector('#btn-payments-cancel').addEventListener('click', () => paymentsOverlay.classList.remove('open'));
  paymentsOverlay.classList.add('open');
});
paymentsOverlay.addEventListener('click', e => { if(e.target === paymentsOverlay) paymentsOverlay.classList.remove('open'); });

// ---------- Mes trajets publiés (côté conducteur) ----------
const myTrajetsOverlay = document.getElementById('my-trajets-overlay');

async function renderMyTrajets(){
  if(!requireLogin()) return;
  const container = document.getElementById('my-trajets-list');
  container.innerHTML = '<p style="opacity:0.6; font-size:13px;">Chargement...</p>';

  try {
    const data = await apiFetch('/trajets/mine/publies');
    if(!data.trajets.length){
      container.innerHTML = '<p style="opacity:0.75; font-size:14px;">Vous n\'avez pas encore publié de trajet.</p>';
      return;
    }

    container.innerHTML = data.trajets.map(t => {
      const dt = new Date(t.dateHeure);
      const dateStr = dt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) + ' à ' + dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      return '<div style="padding:14px 0; border-bottom:1px solid rgba(244,242,236,0.1); display:flex; justify-content:space-between; align-items:center; gap:12px;">' +
        '<div>' +
          '<strong>' + t.villeDepart + ' → ' + t.villeArrivee + '</strong>' +
          '<div style="font-size:12px; opacity:0.65; margin-top:2px;">' + dateStr + ' · ' + t.placesDispo + ' place(s) · ' + t.prixParPlace + ' DT</div>' +
        '</div>' +
        '<button class="toggle-complet-btn" data-id="' + t.id + '" data-complet="' + t.complet + '" style="flex-shrink:0; padding:8px 14px; border-radius:20px; border:1.5px solid ' + (t.complet ? 'var(--red-alert)' : 'var(--green)') + '; background:transparent; color:' + (t.complet ? 'var(--red-alert)' : 'var(--green)') + '; font-family:\'Oswald\',sans-serif; font-size:12px; text-transform:uppercase; cursor:pointer;">' +
          (t.complet ? 'Complet' : 'Disponible') +
        '</button>' +
      '</div>';
    }).join('');

    document.querySelectorAll('.toggle-complet-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const nouveauComplet = btn.dataset.complet !== 'true';
        try {
          await apiFetch('/trajets/' + id + '/complet', {
            method: 'PATCH',
            body: JSON.stringify({ complet: nouveauComplet }),
          });
          renderMyTrajets();
          loadTrajets();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<p style="opacity:0.75; font-size:14px;">' + err.message + '</p>';
  }
}

document.getElementById('menu-my-trajets').addEventListener('click', () => {
  menuOverlay.classList.remove('open');
  myTrajetsOverlay.classList.add('open');
  renderMyTrajets();
});
document.getElementById('btn-my-trajets-cancel').addEventListener('click', () => myTrajetsOverlay.classList.remove('open'));
myTrajetsOverlay.addEventListener('click', e => { if(e.target === myTrajetsOverlay) myTrajetsOverlay.classList.remove('open'); });

// Compte
const accountOverlay = document.getElementById('account-overlay');
const loginOverlay = document.getElementById('login-overlay');
const profileOverlay = document.getElementById('profile-overlay');

function updateAccountIcon(){
  const btn = document.getElementById('btn-account');
  btn.title = currentUser ? ('Connecté : ' + currentUser.nom) : 'Créer un compte';
}

function renderProfileView(user){
  // Avatar : photo si dispo, sinon initiale du nom
  const img = document.getElementById('profile-avatar-img');
  const initial = document.getElementById('profile-avatar-initial');
  if(user.photoUrl){
    img.src = user.photoUrl;
    img.style.display = 'block';
    initial.style.display = 'none';
  } else {
    img.style.display = 'none';
    initial.style.display = 'block';
    initial.textContent = (user.nom || '?').charAt(0).toUpperCase();
  }

  document.getElementById('profile-name-display').textContent = user.nom || '';
  document.getElementById('profile-email-display').textContent = user.email || '';
  document.getElementById('profile-view-age').textContent = user.age || 'Non renseigné';
  document.getElementById('profile-view-telephone').textContent = user.telephone || 'Non renseigné';

  // Champs édition (pré-remplis, même cachés, pour être prêts si on clique "Modifier")
  document.getElementById('prof-nom').value = user.nom || '';
  document.getElementById('prof-age').value = user.age || '';
  document.getElementById('prof-telephone').value = user.telephone || '';
  document.getElementById('prof-nonfumeur').checked = user.nonFumeur;
  document.getElementById('prof-musique').checked = user.musique;
  document.getElementById('prof-clim').checked = user.climatisation;
  document.getElementById('prof-animaux').checked = user.animauxAcceptes;

  // Véhicule : résumé si déjà renseigné, sinon bouton d'ajout
  const vehiculeSummary = document.getElementById('profile-vehicule-summary');
  if(user.vehicule){
    document.getElementById('profile-vehicule-text').textContent = user.vehicule.marque + ' ' + user.vehicule.modele + ' · ' + user.vehicule.couleur;
    document.getElementById('profile-vehicule-places').textContent = user.vehicule.placesTotal + ' place(s) disponible(s)';
    vehiculeSummary.style.display = 'flex';
    document.getElementById('btn-profile-add-vehicule').style.display = 'none';
    document.getElementById('prof-marque').value = user.vehicule.marque;
    document.getElementById('prof-modele').value = user.vehicule.modele;
    document.getElementById('prof-couleur').value = user.vehicule.couleur;
    document.getElementById('prof-places').value = user.vehicule.placesTotal;
  } else {
    vehiculeSummary.style.display = 'none';
    document.getElementById('btn-profile-add-vehicule').style.display = 'flex';
    ['prof-marque','prof-modele','prof-couleur','prof-places'].forEach(id => document.getElementById(id).value = '');
  }
  document.getElementById('profile-vehicule-fields').style.display = 'none';
}

async function openProfile(){
  try {
    const data = await apiFetch('/auth/me');
    currentUser = data.user;
    renderProfileView(currentUser);
    setProfileEditMode(false);
    profileOverlay.classList.add('open');
  } catch (err) {
    alert(err.message);
  }
}

function setProfileEditMode(editing){
  document.getElementById('profile-view-info').style.display = editing ? 'none' : 'block';
  document.getElementById('profile-edit-fields').style.display = editing ? 'block' : 'none';
  document.getElementById('btn-profile-edit').style.display = editing ? 'none' : 'flex';
  document.getElementById('profile-save-actions').style.display = editing ? 'flex' : 'none';
}

document.getElementById('btn-profile-edit').addEventListener('click', () => setProfileEditMode(true));
document.getElementById('btn-profile-cancel-edit').addEventListener('click', () => {
  renderProfileView(currentUser);
  setProfileEditMode(false);
});

document.getElementById('btn-profile-save').addEventListener('click', async () => {
  try {
    const data = await apiFetch('/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        nom: document.getElementById('prof-nom').value.trim(),
        age: parseInt(document.getElementById('prof-age').value) || undefined,
        telephone: document.getElementById('prof-telephone').value.trim(),
        nonFumeur: document.getElementById('prof-nonfumeur').checked,
        musique: document.getElementById('prof-musique').checked,
        climatisation: document.getElementById('prof-clim').checked,
        animauxAcceptes: document.getElementById('prof-animaux').checked,
      }),
    });
    currentUser = { ...currentUser, ...data.user };
    renderProfileView(currentUser);
    setProfileEditMode(false);
  } catch (err) {
    alert(err.message);
  }
});

// Ajouter / modifier le véhicule
document.getElementById('btn-profile-add-vehicule').addEventListener('click', () => {
  document.getElementById('profile-vehicule-fields').style.display = 'block';
  document.getElementById('btn-profile-add-vehicule').style.display = 'none';
});
document.getElementById('btn-profile-vehicule-edit').addEventListener('click', () => {
  document.getElementById('profile-vehicule-fields').style.display = 'block';
  document.getElementById('profile-vehicule-summary').style.display = 'none';
});
document.getElementById('btn-profile-vehicule-cancel').addEventListener('click', () => {
  renderProfileView(currentUser);
});
document.getElementById('btn-profile-vehicule-save').addEventListener('click', async () => {
  const marque = document.getElementById('prof-marque').value.trim();
  const modele = document.getElementById('prof-modele').value.trim();
  const couleur = document.getElementById('prof-couleur').value.trim();
  const places = parseInt(document.getElementById('prof-places').value) || 0;

  if(!marque || !modele || !couleur || places <= 0){
    alert('Merci de remplir tous les champs du véhicule.');
    return;
  }

  try {
    await apiFetch('/profile/vehicule', {
      method: 'PUT',
      body: JSON.stringify({ marque, modele, couleur, immatriculation: currentUser.vehicule ? undefined : 'À renseigner', placesTotal: places }),
    });
    const data = await apiFetch('/auth/me');
    currentUser = data.user;
    renderProfileView(currentUser);
    alert('Véhicule enregistré !');
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('profile-avatar-circle').addEventListener('click', () => {
  document.getElementById('profile-photo-input').click();
});
document.getElementById('profile-photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if(!file) return;
  try {
    const formData = new FormData();
    formData.append('photo', file);
    const res = await fetch(API_BASE + '/profile/photo', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + authToken },
      body: formData,
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "Erreur lors de l'envoi de la photo.");
    currentUser = data.user;
    renderProfileView(currentUser);
  } catch (err) {
    alert('Erreur upload photo : ' + err.message);
  }
});

document.getElementById('btn-profile-close').addEventListener('click', () => {
  profileOverlay.classList.remove('open');
  setProfileEditMode(false);
});
profileOverlay.addEventListener('click', e => { if(e.target === profileOverlay){ profileOverlay.classList.remove('open'); setProfileEditMode(false); } });

document.getElementById('link-profile-logout').addEventListener('click', (e) => {
  e.preventDefault();
  authToken = null;
  currentUser = null;
  updateAccountIcon();
  disconnectGlobalSocket();
  profileOverlay.classList.remove('open');
});

document.getElementById('btn-account').addEventListener('click', () => {
  if(currentUser){
    openProfile();
    return;
  }
  accountOverlay.classList.add('open');
});
document.getElementById('btn-account-cancel').addEventListener('click', () => accountOverlay.classList.remove('open'));
accountOverlay.addEventListener('click', e => { if(e.target === accountOverlay) accountOverlay.classList.remove('open'); });

document.getElementById('link-goto-login').addEventListener('click', e => {
  e.preventDefault();
  accountOverlay.classList.remove('open');
  loginOverlay.classList.add('open');
});
document.getElementById('btn-login-cancel').addEventListener('click', () => loginOverlay.classList.remove('open'));
loginOverlay.addEventListener('click', e => { if(e.target === loginOverlay) loginOverlay.classList.remove('open'); });

document.getElementById('btn-login-confirm').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if(!email || !password){ alert('Merci de renseigner email et mot de passe.'); return; }

  try {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    authToken = data.token;
    currentUser = data.user;
    updateAccountIcon();
    connectGlobalSocket();
    loginOverlay.classList.remove('open');
    alert('Connecté ! Bienvenue ' + currentUser.nom + '.');
  } catch (err) {
    alert(err.message);
  }
});

// Afficher/masquer le mot de passe
function setupPasswordToggle(inputId, btnId){
  document.getElementById(btnId).addEventListener('click', () => {
    const input = document.getElementById(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}
setupPasswordToggle('acc-password', 'acc-password-toggle');
setupPasswordToggle('login-password', 'login-password-toggle');

// Critères de robustesse du mot de passe, vérifiés en direct
function checkPasswordCriteria(password){
  const hasLength = password.length >= 8;
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>_\-+=[\]/\\~`;']/.test(password);
  return [hasLength, hasDigit, hasSpecial];
}

document.getElementById('acc-password').addEventListener('input', (e) => {
  const [hasLength, hasDigit, hasSpecial] = checkPasswordCriteria(e.target.value);
  const rules = { length: hasLength, digit: hasDigit, special: hasSpecial };
  Object.entries(rules).forEach(([rule, ok]) => {
    const el = document.querySelector('#acc-password-criteria [data-rule="' + rule + '"]');
    el.style.opacity = ok ? '1' : '0.5';
    el.style.color = ok ? 'var(--green)' : 'var(--cream)';
    el.textContent = (ok ? '✓ ' : '○ ') + el.textContent.slice(2);
  });
});

document.getElementById('btn-account-confirm').addEventListener('click', async () => {
  const nom = document.getElementById('acc-nom').value.trim();
  const email = document.getElementById('acc-email').value.trim();
  const password = document.getElementById('acc-password').value;

  if(!nom || !email || !password){
    alert('Nom, email et mot de passe sont obligatoires.');
    return;
  }

  if(!checkPasswordCriteria(password).every(Boolean)){
    alert('Le mot de passe doit respecter les 3 critères affichés (longueur, chiffre, caractère spécial).');
    return;
  }

  try {
    const data = await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ nom, email, password }),
    });
    authToken = data.token;
    currentUser = data.user;
    updateAccountIcon();
    connectGlobalSocket();

    // Véhicule optionnel : envoyé seulement si les champs sont remplis
    const marque = document.getElementById('acc-marque').value.trim();
    const modele = document.getElementById('acc-modele').value.trim();
    const couleur = document.getElementById('acc-couleur').value.trim();
    const immat = document.getElementById('acc-immat').value.trim();
    const places = parseInt(document.getElementById('acc-places').value) || 0;

    if(marque && modele && couleur && immat && places > 0){
      await apiFetch('/profile/vehicule', {
        method: 'PUT',
        body: JSON.stringify({ marque, modele, couleur, immatriculation: immat, placesTotal: places }),
      });
    }

    // Préférences
    await apiFetch('/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        nonFumeur: document.getElementById('acc-nonfumeur').checked,
        musique: document.getElementById('acc-musique').checked,
        climatisation: document.getElementById('acc-clim').checked,
        animauxAcceptes: document.getElementById('acc-animaux').checked,
      }),
    });

    // Photo de profil (envoi multipart, en dehors de apiFetch qui est en JSON)
    if(selectedPhotoFile){
      const formData = new FormData();
      formData.append('photo', selectedPhotoFile);
      await fetch(API_BASE + '/profile/photo', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + authToken },
        body: formData,
      });
      selectedPhotoFile = null;
    }

    accountOverlay.classList.remove('open');
    alert('Votre compte a été créé, ' + nom + ' ! Vous êtes maintenant connecté(e).');
  } catch (err) {
    alert(err.message);
  }
});

let selectedPhotoFile = null;
document.getElementById('account-photo-field').addEventListener('click', () => {
  document.getElementById('account-photo-input').click();
});
document.getElementById('account-photo-input').addEventListener('change', (e) => {
  selectedPhotoFile = e.target.files[0] || null;
  document.getElementById('account-photo-field').textContent = selectedPhotoFile
    ? selectedPhotoFile.name
    : 'Cliquez pour ajouter une photo';
});

// À propos
const aboutOverlay = document.getElementById('about-overlay');
document.getElementById('btn-about').addEventListener('click', () => aboutOverlay.classList.add('open'));
document.getElementById('btn-about-cancel').addEventListener('click', () => aboutOverlay.classList.remove('open'));
aboutOverlay.addEventListener('click', e => { if(e.target === aboutOverlay) aboutOverlay.classList.remove('open'); });

const contactOverlay = document.getElementById('contact-overlay');
function openContact(name, trajetId){
  document.getElementById('contact-name').textContent = name;
  document.getElementById('contact-initial').textContent = name.charAt(0).toUpperCase();
  currentChatTrajetId = trajetId;
  contactOverlay.classList.add('open');
}
document.getElementById('btn-contact-cancel').addEventListener('click', () => contactOverlay.classList.remove('open'));
contactOverlay.addEventListener('click', e => { if(e.target === contactOverlay) contactOverlay.classList.remove('open'); });
document.getElementById('contact-call').addEventListener('click', () => alert('Appel de ' + document.getElementById('contact-name').textContent + '...'));

// Messagerie temps réelle (Socket.io)
const chatOverlay = document.getElementById('chat-overlay');

function addChatBubble(msg){
  const container = document.getElementById('chat-messages');
  const mine = msg.expediteur && msg.expediteur.id === currentUser.id;
  const time = new Date(msg.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble ' + (mine ? 'me' : 'them');
  bubble.innerHTML = msg.contenu + '<div class="chat-time">' + time + '</div>';
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

async function connectChat(trajetId){
  if(chatSocket) chatSocket.disconnect();

  document.getElementById('chat-messages').innerHTML = '';

  try {
    const data = await apiFetch('/messages/' + trajetId);
    data.messages.forEach(addChatBubble);
  } catch (err) {
    document.getElementById('chat-messages').innerHTML = '<p style="opacity:0.6; font-size:13px;">' + err.message + '</p>';
    return;
  }

  chatSocket = io('http://localhost:4000', { auth: { token: authToken } });
  chatSocket.on('connect', () => chatSocket.emit('join_trajet', { trajetId }));
  chatSocket.on('new_message', addChatBubble);
  chatSocket.on('error_message', (msg) => alert(msg));
}

document.getElementById('contact-msg').addEventListener('click', () => {
  if(!requireLogin()) return;
  if(!currentChatTrajetId){ alert("Impossible de retrouver ce trajet."); return; }

  const name = document.getElementById('contact-name').textContent;
  document.getElementById('chat-name').textContent = name;
  document.getElementById('chat-initial').textContent = name.charAt(0).toUpperCase();
  contactOverlay.classList.remove('open');
  chatOverlay.classList.add('open');
  connectChat(currentChatTrajetId);

  if(unreadByTrajet[currentChatTrajetId]){
    delete unreadByTrajet[currentChatTrajetId];
    renderNotifBubble();
  }
});

document.getElementById('btn-chat-close').addEventListener('click', () => {
  chatOverlay.classList.remove('open');
  if(chatSocket){ chatSocket.disconnect(); chatSocket = null; }
});
chatOverlay.addEventListener('click', e => {
  if(e.target === chatOverlay){
    chatOverlay.classList.remove('open');
    if(chatSocket){ chatSocket.disconnect(); chatSocket = null; }
  }
});

function sendChatMessage(){
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if(!text || !chatSocket || !currentChatTrajetId) return;
  chatSocket.emit('send_message', { trajetId: currentChatTrajetId, contenu: text });
  input.value = '';
}

document.getElementById('chat-send').addEventListener('click', sendChatMessage);
document.getElementById('chat-input').addEventListener('keyup', e => { if(e.key === 'Enter') sendChatMessage(); });

loadTrajets();
