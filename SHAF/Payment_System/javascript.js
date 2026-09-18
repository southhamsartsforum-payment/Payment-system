// ===== SHAF SALES SYSTEM V10.2 - COMPLETE =====
// Admin access: Triple-tap status message, hidden corner trigger, or Ctrl+R

window.closePicker = function() {
    document.getElementById('itemPickerModal').classList.add('hidden');
};

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
}

// ===== CONFIGURATION =====
const SUMUP_CONFIG = {
    isSandbox: false,
    merchantCode: 'MLVK97UU',
    sandboxCode: 'MPD6ZGWN',
    merchantToken: 'sup_sk_UaErXdUtujuVc68FSA7cpsGNN2zSlU3o3',
    sandboxToken: 'sup_sk_g7wMey8FYUpcfhRYy5SJ2gp7ELz129cBp'
};

const getMerchantCode = () => SUMUP_CONFIG.isSandbox ? SUMUP_CONFIG.sandboxCode : SUMUP_CONFIG.merchantCode;
const getMerchantToken = () => SUMUP_CONFIG.isSandbox ? SUMUP_CONFIG.sandboxToken : SUMUP_CONFIG.merchantToken;
const DEFAULT_CLASS = "p-3 text-left bg-blue-50 border-2 border-blue-200 rounded-xl hover:border-emerald-500 hover:bg-emerald-50 transition-all text-base font-bold";
const EVENT_CONFIG = {
    EVENT_TITLE: "SHAF Sales Dashboard",
    EVENT_CODE: "MH26",
    ADMIN_PASSWORD: "password",
    ARTISTS: [
        "John Ashton", "Caroline Barker", "Helen Campbell", "Amanda Coates", "Christine East",
        "Steve Hedley", "Robert Jones", "Sally Jones", "Gavin Middlewood", "Hazel Owen", "Rachel Smith",
        "Kim Watkins"
    ]
};

const appId = 'shaf-payment-system';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

const firebaseConfig = {
    apiKey: 'AIzaSyDr4JxsAawQy3Fw5nd8-OH-fhrvQ7LoP6M',
    authDomain: 'shaf-payment-system.firebaseapp.com',
    projectId: 'shaf-payment-system',
    storageBucket: 'Transactions',
    messagingSenderId: '531379594614',
    appId: '1:531379594614:web:cb453d19d6087d76aa4657'
};

let app, db, auth;
try {
    if (firebaseConfig.projectId) {
        app = firebase.initializeApp(firebaseConfig);
        db = firebase.firestore();
        auth = firebase.auth();
    }
} catch (e) {
    console.warn('Firebase init error:', e);
}

const ARTIST_LIST_DOC_PATH = 'artifacts/' + appId + '/public/data/' + EVENT_CONFIG.EVENT_CODE + '_artists/list';
const FIRESTORE_TRANSACTIONS_PATH = 'artifacts/' + appId + '/public/data/' + EVENT_CONFIG.EVENT_CODE + '_Transactions';
const INDEXED_DB_NAME = 'SHAFSalesDB_' + EVENT_CONFIG.EVENT_CODE;
const EMAIL_QUEUE_DB_NAME = 'SHAFEmailQueue_' + EVENT_CONFIG.EVENT_CODE;

// ===== STATE VARIABLES =====
let artists = [],
    basketItems = [],
    completedTransactions = [],
    currentTransactionNumber = 1,
    cumulativeTotals = { card: 0, cash: 0 };
let userId = 'loading...',
    sumupEnabled = false,
    sumupMerchantEmail = '',
    sumupPollingInterval = null,
    dbInstance;
let selectedPaymentMethod = '',
    activeOnConfirm = null,
    activeOnReceipt = null;
let currentExhibition = localStorage.getItem('shaf_current_exhibition') || '',
    catalogUnsubscribe = null,
    catalogLoaded = false,
    catalogLoading = false;
let isProcessingEmailQueue = false;

// ===== EMAIL QUEUE SYSTEM =====
function openEmailQueueDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(EMAIL_QUEUE_DB_NAME, 1);
        req.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('emailQueue')) {
                db.createObjectStore('emailQueue', { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = (event) => resolve(event.target.result);
        req.onerror = (event) => reject(event.target.error);
    });
}

function queueEmail(email, subject, body, transactionData) {
    return new Promise(async (resolve, reject) => {
        try {
            const db = await openEmailQueueDB();
            const tx = db.transaction(['emailQueue'], 'readwrite');
            const store = tx.objectStore('emailQueue');
            const entry = {
                email: email,
                subject: subject,
                body: body,
                transactionData: transactionData,
                createdAt: new Date().toISOString(),
                attempts: 0,
                status: 'pending'
            };
            const req = store.add(entry);
            req.onsuccess = () => {
                db.close();
                resolve();
                setTimeout(processEmailQueue, 500);
            };
            req.onerror = () => {
                db.close();
                reject(req.error);
            };
        } catch (err) {
            reject(err);
        }
    });
}

function getQueuedEmails() {
    return new Promise(async (resolve, reject) => {
        try {
            const db = await openEmailQueueDB();
            const tx = db.transaction(['emailQueue'], 'readonly');
            const store = tx.objectStore('emailQueue');
            const req = store.getAll();
            req.onsuccess = () => {
                db.close();
                const pending = req.result.filter(e => e.status === 'pending' || e.status === 'failed');
                resolve(pending);
            };
            req.onerror = () => {
                db.close();
                reject(req.error);
            };
        } catch (err) {
            reject(err);
        }
    });
}

function updateEmailStatus(id, status) {
    return new Promise(async (resolve, reject) => {
        try {
            const db = await openEmailQueueDB();
            const tx = db.transaction(['emailQueue'], 'readwrite');
            const store = tx.objectStore('emailQueue');
            const req = store.get(id);
            req.onsuccess = () => {
                const entry = req.result;
                if (entry) {
                    entry.status = status;
                    entry.updatedAt = new Date().toISOString();
                    if (status === 'sent' || status === 'failed') {
                        entry.attempts = (entry.attempts || 0) + 1;
                    }
                    store.put(entry);
                }
                db.close();
                resolve();
            };
            req.onerror = () => {
                db.close();
                reject(req.error);
            };
        } catch (err) {
            reject(err);
        }
    });
}

async function processEmailQueue() {
    if (isProcessingEmailQueue) {
        console.log('Email queue already processing, skipping...');
        return;
    }

    if (!navigator.onLine) {
        console.log('Offline - email queue will process when online');
        updateConnectionStatus(false);
        return;
    }

    isProcessingEmailQueue = true;

    try {
        console.log('Processing email queue...');
        const pendingEmails = await getQueuedEmails();

        if (pendingEmails.length === 0) {
            console.log('No pending emails in queue');
            isProcessingEmailQueue = false;
            return;
        }

        console.log('Found ' + pendingEmails.length + ' pending emails');
        updateConnectionStatus(true);

        for (const emailEntry of pendingEmails) {
            try {
                console.log('Sending queued email to:', emailEntry.email);
                await sendEmailViaCloud(emailEntry.email, emailEntry.subject, emailEntry.body);
                await updateEmailStatus(emailEntry.id, 'sent');
                console.log('Email sent from queue:', emailEntry.id);
            } catch (err) {
                console.error('Failed to send queued email:', err);
                const attempts = (emailEntry.attempts || 0) + 1;
                if (attempts >= 3) {
                    await updateEmailStatus(emailEntry.id, 'failed');
                    console.log('Email marked as failed after 3 attempts:', emailEntry.id);
                } else {
                    await updateEmailStatus(emailEntry.id, 'pending');
                    console.log('Email will retry later:', emailEntry.id, 'attempt:', attempts);
                }
            }
        }
    } catch (err) {
        console.error('Error processing email queue:', err);
    } finally {
        isProcessingEmailQueue = false;
    }
}

async function sendEmailViaCloud(email, subject, body) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(
            'https://script.google.com/macros/s/AKfycbzFVyBCX14HFPXnpyYTB64KZ4xOvv7Kbv9RpkuXFmB6yWI7dN7Zj4WNxeCr67Gi_w28/exec', {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, subject, body }),
                signal: controller.signal
            }
        );
        clearTimeout(timeoutId);
        return { status: "success" };
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error('Email send timed out');
        }
        throw err;
    }
}

// ===== CONNECTION STATUS WITH POLLING =====
function updateConnectionStatus(isOnline) {
    const badge = document.getElementById('connectionStatus');
    const text = document.getElementById('connectionStatusText');
    if (!badge || !text) return;

    if (isOnline) {
        badge.className = 'online-badge';
        text.textContent = 'Online';
        const statusMsg = document.getElementById('statusMessage');
        if (statusMsg && statusMsg.textContent.includes('offline')) {
            updateStatusMessage('Connection restored. Syncing...', 'info');
        }
    } else {
        badge.className = 'offline-badge';
        text.textContent = 'Offline';
        updateStatusMessage('You are offline. Working with cached data.', 'warning');
    }
}

function checkNetworkStatus() {
    const isOnline = navigator.onLine;
    updateConnectionStatus(isOnline);
    return isOnline;
}

checkNetworkStatus();

window.addEventListener('online', () => {
    console.log('Network online detected');
    checkNetworkStatus();
    updateStatusMessage('Network reconnected. Syncing...', 'info');
    setTimeout(() => {
        syncTransactions();
        processEmailQueue();
    }, 1000);
});

window.addEventListener('offline', () => {
    console.log('Network offline detected');
    checkNetworkStatus();
});

let lastKnownStatus = navigator.onLine;
setInterval(function() {
    const currentStatus = navigator.onLine;
    if (currentStatus !== lastKnownStatus) {
        lastKnownStatus = currentStatus;
        console.log('Polling detected network change:', currentStatus ? 'online' : 'offline');
        if (currentStatus) {
            window.dispatchEvent(new Event('online'));
        } else {
            window.dispatchEvent(new Event('offline'));
        }
    }
}, 3000);

setInterval(function() {
    if (navigator.onLine) {
        processEmailQueue();
    }
}, 30000);

// ===== CATALOG SYSTEM =====
window.SalesApp = {
    Catalogue: {
        data: [],
        getItemsByArtist: function(artistName) {
            const search = artistName ? artistName.toString().trim().toLowerCase() : '';
            return this.data.filter(function(item) {
                const field = item.artistName ? item.artistName.toString().trim().toLowerCase() : '';
                const matchesArtist = (field === search);
                if (!matchesArtist) return false;
                if (currentExhibition) {
                    const exArray = Array.isArray(item.exhibitions) ? item.exhibitions : [];
                    const matchesExhibition = exArray.some(function(ex) {
                        return ex && ex.trim().toLowerCase() === currentExhibition.trim().toLowerCase();
                    });
                    if (!matchesExhibition) return false;
                }
                return true;
            });
        },
        isAvailable: function() {
            return this.data && this.data.length > 0;
        }
    }
};

function loadCatalogueFromFirestore() {
    if (!db) {
        window.SalesApp.Catalogue.data = [];
        catalogLoaded = true;
        populateExhibitionsList();
        return;
    }
    if (catalogLoading) return;
    catalogLoading = true;
    if (catalogUnsubscribe) {
        catalogUnsubscribe();
        catalogUnsubscribe = null;
    }
    catalogUnsubscribe = db.collection("Catalog").onSnapshot(
        (snapshot) => {
            catalogLoading = false;
            catalogLoaded = true;
            window.SalesApp.Catalogue.data = snapshot.docs.map(d => d.data());
            populateExhibitionsList();
            updateStatusMessage('Catalog loaded with ' + window.SalesApp.Catalogue.data.length + ' items.', 'success');
        },
        (error) => {
            catalogLoading = false;
            catalogLoaded = true;
            console.error("Failed to load catalogue:", error);
            if (window.SalesApp.Catalogue.data.length === 0) {
                window.SalesApp.Catalogue.data = [];
                populateExhibitionsList();
                updateStatusMessage('Catalog unavailable. Enter items manually.', 'warning');
            }
        }
    );
}

// ===== UTILITY FUNCTIONS =====
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP',
        minimumFractionDigits: 2
    }).format(amount);
}

function isToday(timestamp) {
    const today = new Date();
    const d = new Date(timestamp);
    return d.getDate() === today.getDate() &&
        d.getMonth() === today.getMonth() &&
        d.getFullYear() === today.getFullYear();
}

function updateStatusMessage(message, type) {
    const el = document.getElementById('statusMessage');
    if (!el) return;
    el.textContent = message;
    if (type === 'error') {
        el.className = "text-base md:text-lg text-right font-bold text-red-500 max-w-xs";
    } else if (type === 'success') {
        el.className = "text-base md:text-lg text-right font-bold text-emerald-600 max-w-xs";
    } else if (type === 'warning') {
        el.className = "text-base md:text-lg text-right font-bold text-amber-600 max-w-xs";
    } else if (type === 'info') {
        el.className = "text-base md:text-lg text-right font-bold text-blue-600 max-w-xs";
    } else {
        el.className = "text-base md:text-lg text-right font-medium text-gray-500 max-w-xs";
    }
}

function showConfirmationModal(title, message, onConfirm, onConfirmWithReceipt = () => {}) {
    const modal = document.getElementById('confirmationModal');
    document.getElementById('confirmationTitle').textContent = title;
    document.getElementById('confirmationMessage').textContent = message;
    activeOnConfirm = onConfirm;
    activeOnReceipt = onConfirmWithReceipt;
    modal.classList.remove('hidden');
    document.getElementById('cancelConfirmationBtn').onclick = function() {
        modal.classList.add('hidden');
        activeOnConfirm = null;
        activeOnReceipt = null;
        selectedPaymentMethod = '';
        document.getElementById('printReceiptModal').classList.remove('hidden');
    };
}

function showSuccessModal(onFinish, onReceipt) {
    const modal = document.getElementById('successModal');
    const finishedBtn = document.getElementById('successFinishedBtn');
    const receiptBtn = document.getElementById('successReceiptBtn');
    if (modal) modal.classList.remove('hidden');
    if (finishedBtn) {
        finishedBtn.onclick = async function() {
            if (modal) modal.classList.add('hidden');
            if (typeof onFinish === 'function') {
                await onFinish();
            }
        };
    }
    if (receiptBtn) {
        receiptBtn.onclick = function() {
            if (modal) modal.classList.add('hidden');
            if (typeof onReceipt === 'function') {
                onReceipt();
            }
        };
    }
}

// ===== INDEXED DB FUNCTIONS =====
function openIndexedDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXED_DB_NAME, 2);
        req.onupgradeneeded = (event) => {
            const idb = event.target.result;
            if (!idb.objectStoreNames.contains("transactions"))
                idb.createObjectStore("transactions", { keyPath: "id", autoIncrement: true });
            if (!idb.objectStoreNames.contains("cumulativeTotals"))
                idb.createObjectStore("cumulativeTotals", { keyPath: "id" });
        };
        req.onsuccess = (event) => {
            dbInstance = event.target.result;
            resolve();
        };
        req.onerror = (event) => reject(event.target.error);
    });
}

function saveTransactionToDB(transaction) {
    if (!dbInstance) return;
    dbInstance.transaction(["transactions"], "readwrite").objectStore("transactions").add(transaction);
}

async function updateTransactionInDB(transactionId, updates) {
    if (!dbInstance) return;
    const store = dbInstance.transaction(["transactions"], "readwrite").objectStore("transactions");
    store.get(transactionId).onsuccess = function(event) {
        const record = event.target.result;
        if (record) {
            Object.assign(record, updates);
            store.put(record);
        }
    };
}

async function clearIndexedDB() {
    return new Promise((resolve, reject) => {
        if (!dbInstance) { resolve(); return; }
        const tx = dbInstance.transaction(["transactions", "cumulativeTotals"], "readwrite");
        const req = tx.objectStore("transactions").clear();
        tx.objectStore("cumulativeTotals").clear();
        req.onsuccess = function() { resolve(); };
        req.onerror = function(e) { reject(e.target.error); };
    });
}

async function saveCumulativeTotalsToDB() {
    if (!dbInstance) return;
    dbInstance.transaction(["cumulativeTotals"], "readwrite")
        .objectStore("cumulativeTotals")
        .put({ id: "totals", card: cumulativeTotals.card, cash: cumulativeTotals.cash });
}

async function loadCumulativeTotalsFromDB() {
    return new Promise(function(resolve) {
        if (!dbInstance) { resolve(); return; }
        const req = dbInstance.transaction(["cumulativeTotals"], "readonly")
            .objectStore("cumulativeTotals").get("totals");
        req.onsuccess = function(event) {
            const saved = event.target.result;
            if (saved) {
                cumulativeTotals.card = saved.card;
                cumulativeTotals.cash = saved.cash;
            }
            renderCumulativeTotals();
            resolve();
        };
    });
}

async function maintenanceOnDateChange(records) {
    if (!dbInstance || records.length === 0) return;
    if (isToday(records[records.length - 1].timestamp)) return;
    const store = dbInstance.transaction(["transactions"], "readwrite").objectStore("transactions");
    records.forEach(function(t) { if (t.synced) store.delete(t.id); });
}

async function loadTransactionsFromDB() {
    return new Promise(function(resolve) {
        if (!dbInstance) { resolve(); return; }
        const req = dbInstance.transaction(["transactions"], "readonly")
            .objectStore("transactions").getAll();
        req.onsuccess = async function(event) {
            const records = event.target.result;
            if (records.length > 0 && !isToday(records[records.length - 1].timestamp)) {
                await maintenanceOnDateChange(records);
                resolve(loadTransactionsFromDB());
                return;
            }
            completedTransactions = records;
            const todays = completedTransactions.filter(function(t) { return isToday(t.timestamp); });
            if (todays.length > 0) {
                const lastNum = todays[todays.length - 1].transactionNumber;
                currentTransactionNumber = (typeof lastNum === 'number' && !isNaN(lastNum)) ? lastNum + 1 : 1;
            } else {
                currentTransactionNumber = 1;
            }
            renderCompletedTransactions();
            resolve();
        };
    });
}

// ===== AUTH =====
async function authenticate() {
    if (!auth) {
        updateStatusMessage('Auth not available - running in offline mode.', 'warning');
        return;
    }
    updateStatusMessage('Connecting to database server...');
    try {
        const credential = initialAuthToken ?
            await auth.signInWithCustomToken(initialAuthToken) :
            await auth.signInAnonymously();
        userId = credential.user.uid;
        updateStatusMessage('Authentication successful.', 'success');
    } catch (error) {
        console.error("Auth error:", error);
        updateStatusMessage('Server connection unavailable.', 'error');
    }
}

// ===== SYNC =====
async function syncTransactions() {
    if (!navigator.onLine || !db || !auth) {
        updateStatusMessage('Offline storage locked. Ready to sync when network resumes.', 'warning');
        return;
    }
    updateStatusMessage('Synchronizing with Firestore...', 'info');
    const unsynced = completedTransactions.filter(function(t) { return !t.synced; });
    if (unsynced.length === 0) {
        updateStatusMessage('All data synced. Device online and ready.', 'success');
        return;
    }
    const col = db.collection(FIRESTORE_TRANSACTIONS_PATH);
    for (let i = 0; i < unsynced.length; i++) {
        const transaction = unsynced[i];
        let allOk = true;
        for (let j = 0; j < transaction.items.length; j++) {
            const item = transaction.items[j];
            const payload = {
                transactionId: transaction.transactionNumber,
                artist: item.artist,
                title: item.title,
                quantity: item.quantity,
                price: item.price,
                totalPrice: item.quantity * item.price,
                paymentMethod: transaction.paymentMethod || 'Unknown',
                saleTimestamp: transaction.timestamp,
                syncedAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            try {
                await col.add(payload);
            } catch (e) {
                console.error("Firestore sync error:", e);
                allOk = false;
                break;
            }
        }
        if (allOk) {
            await updateTransactionInDB(transaction.id, { synced: true });
        } else {
            break;
        }
    }
    await loadTransactionsFromDB();
    updateStatusMessage('Sync complete. Active database is live.', 'success');
}

// ===== ARTIST FUNCTIONS =====
function populateArtistGrid(artistList) {
    const grid = document.getElementById('artistGrid');
    if (!grid) return;
    grid.innerHTML = '';
    artistList.forEach(artistName => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = artistName;
        btn.className = DEFAULT_CLASS;
        btn.onclick = () => {
            const artistInput = document.getElementById('artist');
            if (artistInput) artistInput.value = artistName;
            grid.querySelectorAll('button').forEach(b => {
                b.className = DEFAULT_CLASS;
            });
            btn.className = DEFAULT_CLASS.replace("bg-blue-50 border-blue-200",
                "bg-emerald-200 border-emerald-500");
            const pickerModal = document.getElementById('artistPickerModal');
            if (pickerModal) pickerModal.classList.add('hidden');
            openNewSaleModal(artistName);
        };
        grid.appendChild(btn);
    });
}

function setArtistListTextarea(artistList) {
    const el = document.getElementById('artistListTextarea');
    if (el) el.value = artistList.join('\n');
}

function resetArtistGrid() {
    const grid = document.getElementById('artistGrid');
    if (!grid) return;
    grid.querySelectorAll('button').forEach(b => {
        b.className = DEFAULT_CLASS;
    });
}

function loadArtistsFromFirestore() {
    if (!db) {
        artists = EVENT_CONFIG.ARTISTS;
        populateArtistGrid(artists);
        setArtistListTextarea(artists);
        return;
    }
    db.doc(ARTIST_LIST_DOC_PATH).onSnapshot(function(docSnap) {
        if (docSnap.exists && docSnap.data() && docSnap.data().artists) {
            artists = docSnap.data().artists;
            populateArtistGrid(artists);
            setArtistListTextarea(artists);
            const ts = docSnap.data().lastUpdated;
            const lastUpdated = ts ? ts.toDate().toLocaleString() : 'N/A';
            const statusEl = document.getElementById('artistStatus');
            if (statusEl) statusEl.textContent = 'Live database synced: ' + lastUpdated;
        } else {
            artists = EVENT_CONFIG.ARTISTS;
            populateArtistGrid(artists);
            setArtistListTextarea(artists);
            db.doc(ARTIST_LIST_DOC_PATH).set({
                artists: EVENT_CONFIG.ARTISTS,
                lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
    }, function() {
        artists = EVENT_CONFIG.ARTISTS;
        populateArtistGrid(artists);
        setArtistListTextarea(artists);
    });
}

async function saveArtistsToFirestore() {
    const statusEl = document.getElementById('artistStatus');
    const textarea = document.getElementById('artistListTextarea');
    const newList = textarea.value.split('\n').map(function(n) { return n.trim(); }).filter(function(n) { return n
            .length > 0; });
    if (statusEl) statusEl.textContent = 'Uploading list adjustments...';
    try {
        await db.doc(ARTIST_LIST_DOC_PATH).set({
            artists: newList,
            lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
        });
        if (statusEl) statusEl.textContent = 'Database list altered successfully.';
    } catch (e) {
        if (statusEl) statusEl.textContent = 'Error writing alterations to server.';
    }
}

// ===== CATALOG UI FUNCTIONS =====
function populateExhibitionsList() {
    const exhibitionSelect = document.getElementById('exhibitionSelect');
    if (!exhibitionSelect) return;
    const exhibitionsSet = new Set();
    window.SalesApp.Catalogue.data.forEach(function(item) {
        if (Array.isArray(item.exhibitions)) {
            item.exhibitions.forEach(function(ex) {
                if (ex && typeof ex === 'string') {
                    exhibitionsSet.add(ex.trim());
                }
            });
        }
    });
    const exhibitions = Array.from(exhibitionsSet).sort();
    exhibitionSelect.innerHTML = '<option value="">All Exhibitions (No Filter)</option>';
    exhibitions.forEach(function(ex) {
        const opt = document.createElement('option');
        opt.value = ex;
        opt.textContent = ex;
        if (ex === currentExhibition) {
            opt.selected = true;
        }
        exhibitionSelect.appendChild(opt);
    });
}

function updateHeaderDisplay() {
    const titleEl = document.getElementById('appMainTitle');
    if (!titleEl) return;
    const baseTitle = EVENT_CONFIG.EVENT_TITLE;
    if (currentExhibition) {
        titleEl.textContent = baseTitle + ' — ' + currentExhibition;
    } else {
        titleEl.textContent = baseTitle;
    }
}

// ===== BASKET FUNCTIONS =====
function updateBasketTotals() {
    const totalItems = basketItems.reduce((a, i) => a + i.quantity, 0);
    const totalValue = basketItems.reduce((a, i) => a + (i.quantity * i.price), 0);
    const countEl = document.getElementById('itemCount');
    const totalEl = document.getElementById('basketTotal');
    const receiptEl = document.getElementById('receiptTotal');
    if (countEl) countEl.textContent = totalItems;
    if (totalEl) totalEl.textContent = formatCurrency(totalValue);
    if (receiptEl) receiptEl.textContent = formatCurrency(totalValue);
}

function renderBasket() {
    const tbody = document.getElementById('salesTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    basketItems.forEach(function(item, index) {
        const row = document.createElement('tr');
        row.className = "text-base md:text-lg border-b border-gray-200 hover:bg-slate-50/80 transition-colors";
        row.innerHTML =
            '<td class="py-4 px-4 font-bold text-gray-900">' + item.artist + '</td>' +
            '<td class="py-4 px-4 font-medium text-gray-700 max-w-[250px] whitespace-normal break-words">' +
            item.title + '</td>' +
            '<td class="py-4 px-4 text-center font-black text-gray-800">' + item.quantity + '</td>' +
            '<td class="py-4 px-4 text-gray-600">' + formatCurrency(item.price) + '</td>' +
            '<td class="py-4 px-4 font-black text-indigo-600 text-lg">' + formatCurrency(item.quantity * item
                .price) + '</td>' +
            '<td class="py-4 px-2 text-center"><button class="delete-item inline-flex items-center justify-center w-9 h-9 rounded-full bg-red-50 hover:bg-red-100 text-red-600 hover:text-red-800 font-black text-lg leading-none" data-index="' +
            index + '" aria-label="Remove item">&times;</button></td>';
        tbody.appendChild(row);
    });
    updateBasketTotals();
}

function addItemToBasket(itemData) {
    let idx = -1;
    if (itemData.stockNumber !== undefined && itemData.stockNumber !== null && itemData.stockNumber !== '') {
        idx = basketItems.findIndex(function(item) {
            return item.stockNumber === itemData.stockNumber;
        });
    }
    if (idx > -1) {
        basketItems[idx].quantity += itemData.quantity;
    } else {
        basketItems.push({
            stockNumber: itemData.stockNumber || null,
            artist: itemData.artist,
            title: itemData.title,
            quantity: itemData.quantity,
            price: itemData.price,
            isLimited: itemData.isLimited
        });
    }
    renderBasket();
}

// ===== RENDER FUNCTIONS =====
function renderCumulativeTotals() {
    const daily = { card: 0, cash: 0 };
    completedTransactions.forEach(function(t) {
        if (isToday(t.timestamp)) {
            if (t.paymentMethod === 'Card') daily.card += t.total;
            else daily.cash += t.total;
        }
    });
    const cashToday = document.getElementById('cashTotalTodayDisplay');
    const cardToday = document.getElementById('cardTotalTodayDisplay');
    const overallToday = document.getElementById('overallTotalTodayDisplay');
    const cashAll = document.getElementById('cashTotalAllDisplay');
    const cardAll = document.getElementById('cardTotalAllDisplay');
    const overallAll = document.getElementById('overallTotalAllDisplay');
    if (cashToday) cashToday.textContent = formatCurrency(daily.cash);
    if (cardToday) cardToday.textContent = formatCurrency(daily.card);
    if (overallToday) overallToday.textContent = formatCurrency(daily.card + daily.cash);
    if (cashAll) cashAll.textContent = formatCurrency(cumulativeTotals.cash);
    if (cardAll) cardAll.textContent = formatCurrency(cumulativeTotals.card);
    if (overallAll) overallAll.textContent = formatCurrency(cumulativeTotals.card + cumulativeTotals.cash);
}

function renderCompletedTransactions() {
    const list = document.getElementById('completedTransactionsList');
    if (!list) return;
    list.innerHTML = '';
    const reversed = completedTransactions.slice().reverse();
    reversed.forEach(function(transaction) {
        const el = document.createElement('div');
        const dateString = new Date(transaction.timestamp).toLocaleString();
        const isSynced = transaction.synced;
        const isFromToday = isToday(transaction.timestamp);
        const itemLines = transaction.items.map(function(item) {
            return '<li><span class="font-bold text-gray-900">' + item.quantity + ' x</span> ' + item
                .title +
                ' <span class="text-xs text-indigo-600 font-bold bg-indigo-50 px-2 py-0.5 rounded-full select-none ml-1">' +
                item.artist + '</span>' +
                ' <span class="text-gray-500 text-sm ml-2">— ' + formatCurrency(item.price) +
                ' each (Total: <span class="font-bold text-slate-900">' + formatCurrency(item
                    .quantity * item.price) + '</span>)</span></li>';
        }).join('');
        el.innerHTML =
            '<p class="border-b border-gray-200 pb-2 text-base"><strong>ID: ' + transaction
            .transactionNumber + '</strong> | Subtotal: ' + formatCurrency(transaction.total) +
            ' | Type: ' + transaction.paymentMethod + ' | ' + dateString + '</p>' +
            '<ul class="list-disc list-inside ml-2 py-2 text-gray-700 text-base space-y-1.5">' +
            itemLines + '</ul>';
        el.className = !isSynced ?
            (isFromToday ?
                "p-4 bg-indigo-50/50 rounded-xl border-l-4 border-indigo-500 font-medium text-gray-800 shadow-sm" :
                "p-4 bg-amber-50 rounded-xl border-l-4 border-amber-500 text-amber-900 font-medium shadow-sm") :
            "p-4 bg-gray-50/50 hover:bg-gray-50 rounded-xl border border-gray-200 text-gray-600 shadow-sm";
        list.appendChild(el);
    });
    renderCumulativeTotals();
}

// ===== PANEL FUNCTIONS =====
function showPanel(panelToShow) {
    const transactionsPanel = document.getElementById('transactionsPanel');
    const basketPanel = document.getElementById('basketPanel');
    const showTransactionsBtn = document.getElementById('showTransactionsBtn');
    const showBasketBtn = document.getElementById('showBasketBtn');
    if (!transactionsPanel || !basketPanel) return;
    const inactive = "px-6 py-3.5 bg-gray-400 hover:bg-gray-500 text-white font-bold rounded-lg text-base shadow transition-all";
    const active = "px-6 py-3.5 bg-blue-600 text-white font-black rounded-lg text-base shadow-md border-b-4 border-blue-800";
    transactionsPanel.style.setProperty('display', 'none', 'important');
    basketPanel.style.setProperty('display', 'none', 'important');
    if (showTransactionsBtn) showTransactionsBtn.className = inactive;
    if (showBasketBtn) showBasketBtn.className = inactive;
    if (panelToShow === 'transactions') {
        transactionsPanel.style.setProperty('display', 'flex', 'important');
        if (showTransactionsBtn) showTransactionsBtn.className = active;
        renderCompletedTransactions();
    } else {
        basketPanel.style.setProperty('display', 'flex', 'important');
        if (showBasketBtn) showBasketBtn.className = active;
    }
}

// ===== OPEN FUNCTIONS =====
function openNewSaleModal(selectedArtist) {
    const modal = document.getElementById('newSaleModal');
    if (modal) modal.classList.remove('hidden');
    const displayEl = document.getElementById('displayArtistName');
    if (displayEl) displayEl.textContent = selectedArtist;
    openPickerForArtist(selectedArtist);
}

function openPickerForArtist(artistName) {
    const pickerModal = document.getElementById('itemPickerModal');
    const grid = document.getElementById('pickerGrid');
    const titleInput = document.getElementById('title');
    if (!pickerModal || !grid) return;
    grid.innerHTML = '';

    const items = window.SalesApp.Catalogue.getItemsByArtist(artistName);
    const catalogIsAvailable = window.SalesApp.Catalogue.isAvailable();

    if (!catalogIsAvailable) {
        pickerModal.classList.add('hidden');
        updateStatusMessage('Catalog unavailable. Enter item details manually.', 'warning');
        if (titleInput) {
            titleInput.focus();
            if (titleInput.select) titleInput.select();
        }
        return;
    }

    if (items.length === 0) {
        pickerModal.classList.add('hidden');
        if (titleInput) {
            titleInput.focus();
            if (titleInput.select) titleInput.select();
        }
        return;
    }

    items.sort(function(a, b) {
        const aCard = String(a.material || '').trim().toLowerCase() === 'card';
        const bCard = String(b.material || '').trim().toLowerCase() === 'card';
        if (aCard !== bCard) return aCard ? -1 : 1;
        const aTitle = String(a.title || '');
        const bTitle = String(b.title || '');
        return aTitle.localeCompare(bTitle);
    });

    items.forEach(function(item) {
        const displayPrice = (item.price != null && item.price !== 0) ? item.price : '';
        const isLimited = !!item.isLimited;
        const numAvailable = item.numberAvailable;
        const isSold = isLimited && numAvailable !== null && numAvailable <= 0;
        const btn = document.createElement('button');
        btn.className = 'p-4 border rounded flex items-center justify-between ' + (isSold ?
            'bg-red-50 opacity-60 cursor-not-allowed' : 'bg-white hover:bg-blue-50');
        btn.disabled = isSold;
        const stockDisplay = item.stockNumber || '';
        const mediaDisplay = item.media ? ' • ' + item.media : '';
        const qtyDisplay = isLimited ? ' (Qty: ' + numAvailable + ')' : '';
        btn.innerHTML =
            '<div class="flex flex-col items-start text-left"><span class="text-xs font-mono text-gray-500">' +
            stockDisplay + mediaDisplay + qtyDisplay +
            '</span><span class="font-bold">' + (item.title || '') +
            '</span><span class="text-sm">' + (displayPrice !== '' ? '£' + displayPrice : 'Price TBD') +
            '</span></div>' +
            (isSold ? '<div class="text-xs font-bold text-red-600 bg-red-100 px-2 py-1 rounded">Sold Out</div>' :
                '');
        btn.onclick = function() {
            if (isSold) return;
            document.getElementById('title').value = item.title || '';
            document.getElementById('price').value = displayPrice;
            document.getElementById('stockNumber').value = item.stockNumber || '';
            document.getElementById('isLimited').value = item.isLimited ? 'true' : 'false';
            document.getElementById('artist').value = item.artistName || '';
            document.getElementById('maxAvailableStock').value = item.isLimited ? (item.numberAvailable ||
                0) : 999999;
            pickerModal.classList.add('hidden');
        };
        grid.appendChild(btn);
    });
    pickerModal.classList.remove('hidden');
}

// ===== PROCESS SALE =====
async function processSale(paymentMethod) {
    paymentMethod = paymentMethod || 'Unknown';
    const finalTotal = basketItems.reduce((a, i) => a + (i.quantity * i.price), 0);
    const transaction = {
        transactionNumber: currentTransactionNumber,
        items: basketItems.slice(),
        total: finalTotal,
        paymentMethod: paymentMethod,
        timestamp: new Date().toISOString(),
        synced: false
    };

    for (const item of basketItems) {
        if (item.stockNumber && item.isLimited === true) {
            try {
                const itemRef = db.collection('Catalog').doc(item.stockNumber);
                const qtyToDecrement = item.quantity || 1;

                // Firestore handles local cache update + notifies onSnapshot listener
                await itemRef.update({
                    numberAvailable: firebase.firestore.FieldValue.increment(-qtyToDecrement)
                });

                // REMOVED: Manual local cache update (was causing timing-dependent double-decrement)
                // The onSnapshot listener handles this automatically and correctly

            } catch (error) {
                console.error("Error updating stock for item:", item.stockNumber, error);
            }
        }
    }

    if (paymentMethod === 'Card') cumulativeTotals.card += finalTotal;
    else cumulativeTotals.cash += finalTotal;

    await saveCumulativeTotalsToDB();
    saveTransactionToDB(transaction);
    currentTransactionNumber++;
    basketItems = [];
    renderBasket();

    document.getElementById('printReceiptModal').classList.add('hidden');
    document.getElementById('confirmationModal').classList.add('hidden');
    document.getElementById('emailEntryModal').classList.add('hidden');
    document.getElementById('successModal').classList.add('hidden');
    document.getElementById('sumupOverlayModal').classList.add('hidden');

    renderCumulativeTotals();
    loadTransactionsFromDB().then(function() { syncTransactions(); });
}

// ===== RESET =====
async function resetCompletedTransactions() {
    await clearIndexedDB();
    completedTransactions = [];
    currentTransactionNumber = 1;
    cumulativeTotals = { card: 0, cash: 0 };
    await saveCumulativeTotalsToDB();
    updateStatusMessage('Device cache cleared successfully.');
    const adminModal = document.getElementById('adminModal');
    if (adminModal) adminModal.classList.add('hidden');
    const pwdInput = document.getElementById('resetPassword');
    if (pwdInput) pwdInput.value = '';
    renderCompletedTransactions();
    renderCumulativeTotals();
}

// ===== SUMUP FUNCTIONS =====
async function fetchAndSetReaderId() {
    try {
        const storageKey = SUMUP_CONFIG.isSandbox ? 'virtual_reader_id' : 'active_sumup_reader_id';
        const response = await fetch('https://api.sumup.com/v0.1/merchants/' + getMerchantCode() + '/readers', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + getMerchantToken(), 'Accept': 'application/json' }
        });
        const data = await response.json();
        if (data.items && data.items.length > 0) {
            localStorage.setItem(storageKey, data.items[0].id);
        }
    } catch (error) {
        console.error('[SumUp] Could not fetch reader list:', error);
    }
}

async function pairNewReader(pairingCode, readerName) {
    const response = await fetch('https://api.sumup.com/v0.1/merchants/' + getMerchantCode() + '/readers', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + getMerchantToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairing_code: pairingCode, name: readerName })
    });
    const data = await response.json();
    if (data.id) {
        localStorage.setItem('active_sumup_reader_id', data.id);
        return data.id;
    } else {
        throw new Error("Pairing failed: " + JSON.stringify(data));
    }
}

async function executeSumUpSoloFlow(totalAmount) {
    var overlay = document.getElementById('sumupOverlayModal');
    var msg = document.getElementById('sumupOverlayMessage');
    const receiptModal = document.getElementById('printReceiptModal');
    if (receiptModal) receiptModal.classList.add('hidden');
    if (overlay) overlay.classList.remove('hidden');
    if (msg) msg.textContent = "Connecting to Terminal...";

    var readerId = SUMUP_CONFIG.isSandbox ?
        localStorage.getItem('virtual_reader_id') :
        localStorage.getItem('active_sumup_reader_id');

    if (!readerId) {
        if (overlay) overlay.classList.add('hidden');
        if (receiptModal) receiptModal.classList.remove('hidden');
        updateStatusMessage('No SumUp reader paired. Pair a reader in Admin menu.', 'error');
        return;
    }

    try {
        // Step 1: Check reader status BEFORE sending charge
        var preCheckResp = await fetch('https://api.sumup.com/v0.1/merchants/' + getMerchantCode() +
            '/readers/' + readerId + '/status', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + getMerchantToken() }
            });

        if (!preCheckResp.ok) {
            if (overlay) overlay.classList.add('hidden');
            if (receiptModal) receiptModal.classList.remove('hidden');
            updateStatusMessage('SumUp terminal is not responding. Check it is switched on.', 'error');
            return;
        }

        var preCheckData = await preCheckResp.json();
        var preState = (preCheckData.data && preCheckData.data.state) ? preCheckData.data.state : 'UNKNOWN';

        if (preState === 'UNKNOWN' || preState === 'OFFLINE') {
            if (overlay) overlay.classList.add('hidden');
            if (receiptModal) receiptModal.classList.remove('hidden');
            updateStatusMessage('SumUp terminal appears offline. Check it is switched on and connected.', 'error');
            return;
        }

        // Step 2: Send the charge to the reader
        var triggerUrl = 'https://api.sumup.com/v0.1/merchants/' + getMerchantCode() + '/readers/' + readerId +
            '/checkout';
        var response = await fetch(triggerUrl, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + getMerchantToken(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ total_amount: { currency: "GBP", minor_unit: 2, value: Math.round(
                        totalAmount * 100) } })
        });

        var responseData = await response.json();

        if (!response.ok) {
            if (overlay) overlay.classList.add('hidden');
            if (receiptModal) receiptModal.classList.remove('hidden');
            // Try to extract meaningful error
            var errMsg = responseData.message || responseData.error_message || 'Unknown error';
            if (errMsg.toLowerCase().includes('offline') || errMsg.toLowerCase().includes('unavailable')) {
                updateStatusMessage('SumUp terminal is offline. Check it is switched on.', 'error');
            } else {
                updateStatusMessage('Could not contact SumUp terminal: ' + errMsg, 'error');
            }
            return;
        }

        var checkoutId = responseData.data ? responseData.data.checkout_id : (responseData.checkout_id ||
            responseData.id);
        if (!checkoutId) {
            if (overlay) overlay.classList.add('hidden');
            if (receiptModal) receiptModal.classList.remove('hidden');
            updateStatusMessage('SumUp did not return a valid checkout reference.', 'error');
            return;
        }

        if (msg) msg.textContent = "Terminal Active. Please complete payment on device...";
        if (sumupPollingInterval) clearInterval(sumupPollingInterval);

        var pollAttempts = 0;
        var maxPollAttempts = 60; // ~2 minutes (was 45)
        var hasStarted = false;
        var startCheckAttempts = 0;

        sumupPollingInterval = setInterval(async function() {
            try {
                pollAttempts++;

                var statusResp = await fetch('https://api.sumup.com/v0.1/merchants/' + getMerchantCode() +
                    '/readers/' + readerId + '/status', {
                        method: 'GET',
                        headers: { 'Authorization': 'Bearer ' + getMerchantToken() }
                    });

                if (!statusResp.ok) {
                    // Reader went unreachable mid-transaction
                    if (pollAttempts > 5) {
                        clearInterval(sumupPollingInterval);
                        if (overlay) overlay.classList.add('hidden');
                        if (receiptModal) receiptModal.classList.remove('hidden');
                        updateStatusMessage('Lost connection to SumUp terminal. Transaction not completed.', 'error');
                    }
                    return;
                }

                var statusData = await statusResp.json();
                var readerState = (statusData.data && statusData.data.state) ? statusData.data.state : "UNKNOWN";

                if (readerState === 'WAITING_FOR_CARD' || readerState === 'PROCESSING') {
                    hasStarted = true;
                }

                // If reader never picked up the request (still IDLE after several polls)
                if (!hasStarted && readerState === 'IDLE') {
                    startCheckAttempts++;
                    if (startCheckAttempts >= 10) { // ~20 seconds
                        clearInterval(sumupPollingInterval);
                        if (overlay) overlay.classList.add('hidden');
                        if (receiptModal) receiptModal.classList.remove('hidden');
                        updateStatusMessage('Terminal did not respond to charge request. Transaction cancelled.', 'error');
                        return;
                    }
                }

                if (hasStarted && readerState === 'IDLE') {
                    clearInterval(sumupPollingInterval);

                    var checkoutResp = await fetch('https://api.sumup.com/v0.1/merchants/' + getMerchantCode() +
                        '/readers/' + readerId + '/checkout/' + checkoutId, {
                            method: 'GET',
                            headers: { 'Authorization': 'Bearer ' + getMerchantToken() }
                        });

                    if (overlay) overlay.classList.add('hidden');

                    if (checkoutResp.ok) {
                        var checkoutData = await checkoutResp.json();
                        var payObj = checkoutData.data || checkoutData;
                        var paymentStatus = (payObj.payment_status || payObj.status || '').toUpperCase();

                        if (paymentStatus === 'PAID' || paymentStatus === 'SUCCESSFUL') {
                            showSuccessModal(
                                async function() {
                                    await processSale(selectedPaymentMethod);
                                },
                                function() {
                                    var emailModal = document.getElementById('emailEntryModal');
                                    if (emailModal) {
                                        emailModal.classList.remove('hidden');
                                    }
                                }
                            );
                            return;
                        } else if (paymentStatus === 'CANCELLED' || paymentStatus === 'CANCELED') {
                            if (receiptModal) receiptModal.classList.remove('hidden');
                            updateStatusMessage('Transaction cancelled at SumUp terminal.', 'error');
                            return;
                        } else if (paymentStatus === 'FAILED' || paymentStatus === 'DECLINED') {
                            if (receiptModal) receiptModal.classList.remove('hidden');
                            updateStatusMessage('Payment declined or failed at SumUp terminal.', 'error');
                            return;
                        } else if (paymentStatus === 'EXPIRED') {
                            if (receiptModal) receiptModal.classList.remove('hidden');
                            updateStatusMessage('SumUp checkout expired. Please try again.', 'error');
                            return;
                        } else {
                            if (receiptModal) receiptModal.classList.remove('hidden');
                            updateStatusMessage('Payment not completed. Status: ' + (paymentStatus || 'UNKNOWN'),
                                'error');
                            return;
                        }
                    }

                    if (receiptModal) receiptModal.classList.remove('hidden');
                    updateStatusMessage('Could not verify payment status with SumUp.', 'error');
                    return;
                }

                if (pollAttempts >= maxPollAttempts) {
                    clearInterval(sumupPollingInterval);
                    if (overlay) overlay.classList.add('hidden');
                    if (receiptModal) receiptModal.classList.remove('hidden');
                    if (hasStarted) {
                        updateStatusMessage('Transaction timed out waiting for customer. Please retry.', 'error');
                    } else {
                        updateStatusMessage('Transaction timed out - terminal did not respond.', 'error');
                    }
                }

            } catch (e) {
                console.error("Polling error:", e);
            }
        }, 2000);

    } catch (error) {
        console.error("SumUp initiation error:", error);
        if (overlay) overlay.classList.add('hidden');
        if (receiptModal) receiptModal.classList.remove('hidden');
        updateStatusMessage('Failed to complete transaction: ' + error.message, 'error');
    }
}
function abortSumUpTransaction() {
    if (sumupPollingInterval) clearInterval(sumupPollingInterval);
    const overlay = document.getElementById('sumupOverlayModal');
    if (overlay) overlay.classList.add('hidden');
    showConfirmationModal('Bypass Active SumUp Flow', 'Force mark transaction as paid manually via card?', function() {
        processSale(selectedPaymentMethod);
    });
}

// ===== ADMIN ACCESS METHODS =====

// Method 1: Triple-tap on status message (works on all devices)
(function() {
    var el = document.getElementById('statusMessage');
    if (!el) return;
    var tapCount = 0,
        tapTimer = null;
    el.style.cursor = 'pointer';
    el.title = 'Tap 3 times for admin';

    el.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        e.stopPropagation();
        return false;
    });

    el.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(tapTimer);
        tapCount++;
        if (tapCount === 1) {
            tapTimer = setTimeout(function() { tapCount = 0; }, 600);
        } else if (tapCount === 3) {
            tapCount = 0;
            clearTimeout(tapTimer);
            document.getElementById('adminModal').classList.remove('hidden');
            document.getElementById('resetPassword').focus();
//            updateStatusMessage('Admin opened.', 'info');
        }
    });

    el.addEventListener('touchstart', function(e) {}, { passive: true });
})();

// Method 2: Hidden corner trigger - FIXED
function setupHiddenAdminTrigger() {
    // Check if body exists
    if (!document.body) {
        // If body doesn't exist, wait for it
        document.addEventListener('DOMContentLoaded', function() {
            createHiddenTrigger();
        });
        return;
    }
    createHiddenTrigger();
}

function createHiddenTrigger() {
    var trigger = document.createElement('div');
    trigger.id = 'hiddenAdminTrigger';
    trigger.style.cssText = 'position:fixed;top:0;left:0;width:40px;height:40px;opacity:0.01;pointer-events:all;cursor:pointer;z-index:9999;';
    trigger.setAttribute('aria-hidden', 'true');
    document.body.appendChild(trigger);

    var tapCount = 0,
        tapTimer = null;
    trigger.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        e.stopPropagation();
        return false;
    });
    trigger.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(tapTimer);
        tapCount++;
        if (tapCount === 1) {
            tapTimer = setTimeout(function() { tapCount = 0; }, 600);
        } else if (tapCount === 3) {
            tapCount = 0;
            clearTimeout(tapTimer);
            document.getElementById('adminModal').classList.remove('hidden');
            document.getElementById('resetPassword').focus();
   //         updateStatusMessage('Admin opened.', 'info');
        }
    });
    trigger.addEventListener('touchstart', function(e) {}, { passive: true });
}

// Method 3: Keyboard shortcut Ctrl+R (desktop only)
document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
        e.preventDefault();
        document.getElementById('adminModal').classList.remove('hidden');
        document.getElementById('resetPassword').focus();
//        updateStatusMessage('Admin opened (Ctrl+R).', 'info');
    }
});

// ===== APP INITIALIZATION =====
// ===== APP INITIALIZATION =====
async function initApp() {
    updateHeaderDisplay();
    await authenticate();

    try {
        await openIndexedDB();
        await loadTransactionsFromDB();
        await loadCumulativeTotalsFromDB();

        sumupEnabled = localStorage.getItem('shaf_sumup_enabled') === 'true';
        sumupMerchantEmail = localStorage.getItem('shaf_sumup_email') || 'treasurer@shaf.org.uk';
        const sumupToggle = document.getElementById('sumupToggle');
        const sumupEmailInput = document.getElementById('sumupEmailInput');
        if (sumupToggle) sumupToggle.checked = sumupEnabled;
        if (sumupEmailInput) sumupEmailInput.value = sumupMerchantEmail;
    } catch (error) {
        console.error("Init error:", error);
        updateStatusMessage('Local system storage isolated.', 'error');
    }

    loadArtistsFromFirestore();
    await loadCatalogueFromFirestore();
    updateBasketTotals();
    showPanel('basket');
    fetchAndSetReaderId();
    
    // Setup hidden admin trigger AFTER body is ready
    setupHiddenAdminTrigger();

    // ===== ALL EVENT LISTENERS MUST BE INSIDE initApp() =====

    document.getElementById('showSaleModalBtn').addEventListener('click', function() {
        document.getElementById('newSaleForm').reset();
        document.getElementById('artist').value = '';
        document.getElementById('quantity').value = 1;
        resetArtistGrid();
        document.getElementById('artistPickerModal').classList.remove('hidden');
    });

    document.getElementById('cancelSaleBtn').addEventListener('click', function() {
        document.getElementById('newSaleForm').reset();
        document.getElementById('artist').value = '';
        document.getElementById('quantity').value = 1;
        document.getElementById('newSaleModal').classList.add('hidden');
    });

    document.getElementById('newSaleForm').addEventListener('submit', function(e) {
        e.preventDefault();
        var stockNumber = document.getElementById('stockNumber').value;
        var artist = document.getElementById('artist').value;
        var title = document.getElementById('title').value;
        var quantity = parseInt(document.getElementById('quantity').value, 10);
        var price = parseFloat(document.getElementById('price').value);
        var rawIsLimited = document.getElementById('isLimited').value;
        var isLimited = (rawIsLimited === 'true' || rawIsLimited === true || rawIsLimited === '1');
        var maxAvailable = parseInt(document.getElementById('maxAvailableStock').value, 10);

        if (isLimited && quantity > maxAvailable) {
            alert('Selected quantity (' + quantity + ') exceeds number available (' + maxAvailable +
                '). Please adjust the quantity.');
            return;
        }

        if (artist && title && quantity > 0 && price >= 0) {
            addItemToBasket({
                stockNumber: stockNumber,
                artist: artist,
                title: title,
                quantity: quantity,
                price: price,
                isLimited: isLimited
            });
            this.reset();
            document.getElementById('quantity').value = 1;
            document.getElementById('newSaleModal').classList.add('hidden');
        } else {
            alert("Please ensure all fields are filled out correctly.");
        }
    });

    document.getElementById('decQtyBtn').addEventListener('click', function(e) {
        e.preventDefault();
        var q = document.getElementById('quantity');
        var val = parseInt(q.value, 10) || 1;
        if (val > 1) q.value = val - 1;
    });

    document.getElementById('incQtyBtn').addEventListener('click', function(e) {
        e.preventDefault();
        var q = document.getElementById('quantity');
        q.value = (parseInt(q.value, 10) || 1) + 1;
    });

    document.getElementById('salesTableBody').addEventListener('click', function(e) {
        if (e.target.classList.contains('delete-item')) {
            basketItems.splice(parseInt(e.target.getAttribute('data-index'), 10), 1);
            renderBasket();
        }
    });

    document.getElementById('clearBasketBtn').addEventListener('click', function() {
        if (basketItems.length > 0) { basketItems = [];
            renderBasket(); }
    });

    document.getElementById('showPrintReceiptModalBtn').addEventListener('click', function() {
        if (basketItems.length === 0) {
            updateStatusMessage('Cannot checkout an empty basket.', 'error');
            return;
        }
        updateBasketTotals();
        document.getElementById('printReceiptModal').classList.remove('hidden');
    });

    document.getElementById('cashBtn').addEventListener('click', function() {
        selectedPaymentMethod = 'Cash';
        var total = basketItems.reduce((a, i) => a + (i.quantity * i.price), 0);
        showConfirmationModal('Confirm Cash Payment', 'Confirm once ' + formatCurrency(total) + ' received',
            function() { processSale(selectedPaymentMethod); });
    });

    document.getElementById('cardBtn').addEventListener('click', function() {
        selectedPaymentMethod = 'Card';
        var total = basketItems.reduce((a, i) => a + (i.quantity * i.price), 0);
        if (sumupEnabled) {
            executeSumUpSoloFlow(total);
        } else {
            showConfirmationModal('Confirm Card Payment', 'Confirm ' + formatCurrency(total) +
                ' when SumUp terminal shows Transaction Complete',
                function() { processSale(selectedPaymentMethod); }
            );
        }
    });

    document.getElementById('cancelPrintBtn').addEventListener('click', function() {
        document.getElementById('printReceiptModal').classList.add('hidden');
    });

    document.getElementById('cancelSumUpBtn').addEventListener('click', abortSumUpTransaction);

    document.getElementById('showTransactionsBtn').addEventListener('click', function() { showPanel('transactions'); });
    document.getElementById('showBasketBtn').addEventListener('click', function() { showPanel('basket'); });

    document.getElementById('cancelResetBtn').addEventListener('click', function() {
        document.getElementById('adminModal').classList.add('hidden');
        document.getElementById('resetPassword').value = '';
    });

    document.getElementById('closeAdminXBtn').addEventListener('click', function() {
        document.getElementById('adminModal').classList.add('hidden');
        document.getElementById('resetPassword').value = '';
    });

    document.getElementById('confirmResetBtn').addEventListener('click', function() {
        const pwdInput = document.getElementById('resetPassword');
        if (pwdInput && pwdInput.value === EVENT_CONFIG.ADMIN_PASSWORD) {
            resetCompletedTransactions();
        } else {
            updateStatusMessage('Incorrect Admin Credentials.', 'error');
            if (pwdInput) pwdInput.value = '';
        }
    });

    document.getElementById('exhibitionSelect').addEventListener('change', function(e) {
        const pwdInput = document.getElementById('resetPassword');
        if (pwdInput && pwdInput.value === EVENT_CONFIG.ADMIN_PASSWORD) {
            currentExhibition = e.target.value;
            localStorage.setItem('shaf_current_exhibition', currentExhibition);
            updateHeaderDisplay();
            updateStatusMessage('Active exhibition updated successfully.', 'success');
        } else {
            updateStatusMessage('Incorrect Admin Credentials.', 'error');
            if (pwdInput) pwdInput.value = '';
            e.target.value = currentExhibition;
        }
    });

    document.getElementById('saveArtistsBtn').addEventListener('click', function() {
        const pwdInput = document.getElementById('resetPassword');
        if (pwdInput && pwdInput.value === EVENT_CONFIG.ADMIN_PASSWORD) {
            saveArtistsToFirestore();
        } else {
            var s = document.getElementById('artistStatus');
            if (s) s.textContent = "Error: Invalid admin password entry.";
        }
    });

    document.getElementById('sumupToggle').addEventListener('change', function(e) {
        sumupEnabled = e.target.checked;
        localStorage.setItem('shaf_sumup_enabled', sumupEnabled);
    });

    document.getElementById('sumupEmailInput').addEventListener('change', function(e) {
        sumupMerchantEmail = e.target.value.trim();
        localStorage.setItem('shaf_sumup_email', sumupMerchantEmail);
    });

    document.getElementById('pairReaderBtn').addEventListener('click', async function() {
        var code = document.getElementById('pairingCodeInput').value;
        var name = document.getElementById('readerNameInput').value;
        if (code && name) {
            await pairNewReader(code, name);
        } else {
            alert("Please enter both a pairing code and a reader name.");
        }
    });

    // ===== EMAIL RECEIPT HANDLERS =====

    document.getElementById('cancelEmailBtn').addEventListener('click', function() {
        document.getElementById('emailEntryModal').classList.add('hidden');
        document.getElementById('customerEmail').value = '';
        document.getElementById('confirmationModal').classList.remove('hidden');
    });

    document.getElementById('sendEmailBtn').addEventListener('click', async function() {
        const email = document.getElementById('customerEmail').value.trim();
        if (!email) {
            alert("Please enter an email address");
            return;
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            alert("Please enter a valid email address (e.g., name@example.com).");
            return;
        }

        const items = basketItems;
        const total = document.getElementById('basketTotal').innerText;
        const emailBody = '<h3>Receipt for your purchase at SHAF</h3><p>Date: ' + new Date().toLocaleDateString() +
            '</p><table border="1" style="border-collapse: collapse; width: 100%;"><thead><tr><th>Artist</th><th>Title</th><th>Qty</th><th>Price</th></tr></thead><tbody>' +
            items.map(item => '<tr><td>' + item.artist + '</td><td>' + item.title + '</td><td align="center">' +
                item.quantity + '</td><td>£' + item.price + '</td></tr>').join('') +
            '</tbody></table><p><strong>Total Paid: ' + total + '</strong></p>';

        this.disabled = true;
        this.innerText = "Processing...";

        try {
            if (navigator.onLine) {
                try {
                    await sendEmailViaCloud(email, "Your SHAF Receipt", emailBody);
                    this.innerText = "Sent!";
                    document.getElementById('emailEntryModal').classList.add('hidden');
                    document.getElementById('confirmationModal').classList.add('hidden');
                    document.getElementById('customerEmail').value = '';
                    setTimeout(() => {
                        this.innerText = "Send Receipt";
                        this.disabled = false;
                        processSale(selectedPaymentMethod);
                    }, 1000);
                    return;
                } catch (sendError) {
                    console.error('Send failed, queuing:', sendError);
                    await queueEmail(email, "Your SHAF Receipt", emailBody, { items: items, total: total });
                    this.innerText = "Queued";
                    alert(
                        "Email send failed but has been queued. It will be sent when connection is restored."
                        );
                    document.getElementById('emailEntryModal').classList.add('hidden');
                    document.getElementById('confirmationModal').classList.add('hidden');
                    document.getElementById('customerEmail').value = '';
                    setTimeout(() => {
                        this.innerText = "Send Receipt";
                        this.disabled = false;
                        processSale(selectedPaymentMethod);
                    }, 1000);
                    return;
                }
            } else {
                await queueEmail(email, "Your SHAF Receipt", emailBody, { items: items, total: total });
                this.innerText = "Queued";
                alert(
                    "You are offline. The receipt has been queued and will be sent when you reconnect.");
                document.getElementById('emailEntryModal').classList.add('hidden');
                document.getElementById('confirmationModal').classList.add('hidden');
                document.getElementById('customerEmail').value = '';
                setTimeout(() => {
                    this.innerText = "Send Receipt";
                    this.disabled = false;
                    processSale(selectedPaymentMethod);
                }, 1000);
                return;
            }
        } catch (error) {
            console.error('Email error:', error);
            alert("Failed to process email: " + error.message);
            this.innerText = "Send Receipt";
            this.disabled = false;
        }
    });

    document.getElementById('confirmReceiptBtn').addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('confirmationModal').classList.add('hidden');
        document.getElementById('emailEntryModal').classList.remove('hidden');
        const emailInput = document.getElementById('customerEmail');
        if (emailInput) {
            emailInput.value = '';
            setTimeout(function() {
                emailInput.focus();
            }, 100);
        }
    });

    document.getElementById('confirmPaymentBtn').addEventListener('click', function() {
        if (activeOnConfirm) activeOnConfirm();
        document.getElementById('confirmationModal').classList.add('hidden');
        document.getElementById('emailEntryModal').classList.add('hidden');
    });
    
    // ===== END OF initApp() =====
}

// ===== START APP =====
if (document.readyState === 'loading') {
    window.addEventListener('load', initApp);
} else {
    initApp();
}
