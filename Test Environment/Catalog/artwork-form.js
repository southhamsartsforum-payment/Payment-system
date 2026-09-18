//This version 13:00 16/9 is modified to strengthen the handling of generatestocknumbers
//It is active on stevedooleywoodart but not on SHAF.


function initArtworkApp() {
    // REPLACE THESE WITH YOUR ACTUAL FIREBASE CONFIG DETAILS
    const firebaseConfig = {
        apiKey:            'AIzaSyDr4JxsAawQy3Fw5nd8-OH-fhrvQ7LoP6M',
        authDomain:        'shaf-payment-system.firebaseapp.com',
        projectId:         'shaf-payment-system',
        storageBucket:     'Transactions',
        messagingSenderId: '531379594614',
        appId:             '1:531379594614:web:cb453d19d6087d76aa4657'
    };
    
console.log("1. Script started");

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const db = firebase.firestore();

 //db.settings({			// to improve response time on ios devices.  No longer necessary
  //  experimentalForceLongPolling: true
//});

console.log("2. Firebase initialized");

    const formContainer = document.getElementById('artwork-form-container');
    const form = document.getElementById('artwork-submission-form');
    const listContainer = document.getElementById('artwork-list-container');
    const addBtn = document.getElementById('show-add-form-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const formHeading = document.getElementById('form-title-heading');
    const isLimitedCheckbox = document.getElementById('art-is-limited');
    const numberAvailableGroup = document.getElementById('number-available-group');
    const submitBtn = document.getElementById('submit-artwork-btn');

    if (typeof wpUser === 'undefined') {
        console.error("wpUser is not defined.");
        if (listContainer) listContainer.innerHTML = '<p style="color: red;">User session error.</p>';
        return;
    }
    
    console.log("3. Attempting authentication...");
    firebase.auth().signInAnonymously()
        .then(() => {
            loadArtistArtworks();
            console.log("4. Auth successful:", wpUser.id);
        })
        .catch((authError) => {
            console.error("Firebase auth failed:", authError);
            listContainer.innerHTML = `<p style="color: red;">Auth Error: ${authError.message}</p>`;
        });

    // Toggle "Number Available" field visibility based on "Limited" checkbox
    isLimitedCheckbox.addEventListener('change', function() {
        if (this.checked) {
            numberAvailableGroup.style.display = 'block';
        } else {
            numberAvailableGroup.style.display = 'none';
        }
    });

  // ---------- UNIQUE STOCK NUMBER GENERATOR (globally unique, atomic counter) ----------
// Stock numbers are globally unique per initials group (ABC-00001, ABC-00002 …).
// Uses an atomic Firestore transaction on StockCounters/{initials} — do NOT
// revert to scanning Catalog: the scan made every add progressively slower
// (and broke iOS entirely). See also: cache-busting in functions.php.

async function generateUniqueStockNumber(db) {
    // Get artist initials (3 chars max)
    let initials = wpUser.name
        .split(' ')
        .map(n => n[0]) // Fixed: ensure it grabs first char of split parts properly
        .join('')
        .toUpperCase()
        .substring(0, 3);
    if (!initials) initials = 'ART';

    // Use the db instance passed into the function to create references
    const counterRef = db.collection('StockCounters').doc(initials);

    // Atomically grab the next number for this initials group
    const newNumber = await db.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const next = (snap.exists ? (snap.data().lastNumber || 0) : 0) + 1;
        
        // FIX: Keep tx.set, but remove the third {merge: true} parameter completely
        tx.set(counterRef, { lastNumber: next });
        
        return next;
    });

    let serial = String(newNumber).padStart(5, '0');
    let candidate = `${initials}-${serial}`;

    // Standard Catalog validation check
    const existing = await db.collection('Catalog').doc(candidate).get();
    if (!existing.exists) {
        console.log(`✅ Generated unique stock number: ${candidate}`);
        return candidate;
    }

    console.warn(`⚠️ ${candidate} already exists, scanning forward…`);
    for (let i = newNumber + 1; i <= newNumber + 1000; i++) {
        const serial2 = String(i).padStart(5, '0');
        const candidate2 = `${initials}-${serial2}`;
        const doc2 = await db.collection('Catalog').doc(candidate2).get();
        if (!doc2.exists) {
            // FIX: Remove {merge: true} here as well to ensure clean cross-platform saves
            await counterRef.set({ lastNumber: i });
            console.log(`✅ Generated unique stock number: ${candidate2}`);
            return candidate2;
        }
    }

    throw new Error('Could not find a free stock number in the next 1000 slots.');
}
    // ---------- INPUT VALIDATION ----------
    function validateArtworkForm(data) {
        const errors = [];
        
        // Title validation
        if (!data.title || data.title.trim().length === 0) {
            errors.push('Title is required.');
        } else if (data.title.trim().length > 200) {
            errors.push('Title must be 200 characters or less.');
        }
        
        // Price validation
        if (isNaN(data.price) || data.price <= 0) {
            errors.push('Price must be a positive number.');
        } else if (data.price > 999999.99) {
            errors.push('Price cannot exceed £999,999.99.');
        }
        
        // Media validation
        if (!data.media || data.media.trim().length === 0) {
            errors.push('Media/medium is required.');
        } else if (data.media.trim().length > 100) {
            errors.push('Media must be 100 characters or less.');
        }
        
        // Limited edition validation
        if (data.isLimited) {
            if (isNaN(data.numberAvailable) || data.numberAvailable < 1) {
                errors.push('Number available must be at least 1 for limited editions.');
            } else if (data.numberAvailable > 99999) {
                errors.push('Number available cannot exceed 99,999.');
            }
        }
        
        // Exhibitions validation (optional but sanitize)
        if (data.exhibitions && data.exhibitions.length > 20) {
            errors.push('You can select a maximum of 20 exhibitions.');
        }
        
        return errors;
    }

    // ---------- LOADING STATES ----------
    function showLoading(container, message = 'Loading...') {
        if (container) {
            container.innerHTML = `<p style="color: #666; padding: 20px; text-align: center;">⏳ ${message}</p>`;
        }
    }

    function setButtonLoading(button, isLoading) {
        if (!button) return;
        if (isLoading) {
            button.disabled = true;
            button.dataset.originalText = button.innerText;
            button.innerText = '⏳ Saving...';
        } else {
            button.disabled = false;
            if (button.dataset.originalText) {
                button.innerText = button.dataset.originalText;
            }
        }
    }

    // ---------- LOAD ARTWORKS (using artistId - matches your index) ----------
    async function loadArtistArtworks() {
        console.log("5. Starting Firestore query for artistId:", wpUser.id);
        
        // Show loading state
        showLoading(listContainer, 'Loading your artworks...');
        
        try {
            // ✅ Using artistId (matches your index)
            const snapshot = await db.collection('Catalog')
                .where('artistId', '==', wpUser.id)  // ✅ artistId (lowercase 'd')
                .orderBy('stockNumber')
                .get();
            
            console.log("6. Query complete. Docs found:", snapshot.size);
            
            if (snapshot.empty) {
                listContainer.innerHTML = '<p style="color: #666; padding: 20px; text-align: center;">📭 You have not added any artworks yet.</p>';
                return;
            }

            let html = '<table style="width: 100%; border-collapse: collapse;">';
            html += '<tr style="background: #eee; text-align: left;"><th style="padding: 10px;">Stock #</th><th>Title</th><th>Price</th><th>Limited / Qty</th><th>Exhibitions</th><th>Actions</th></tr>';

            snapshot.forEach(doc => {
                const art = doc.data();
                const exhibitionsList = art.exhibitions && art.exhibitions.length > 0 
                    ? art.exhibitions.join(', ') 
                    : 'None';
                const qtyDisplay = art.isLimited 
                    ? `Yes (${art.numberAvailable} left)` 
                    : 'No (Open)';

                html += `<tr style="border-bottom: 1px solid #ddd;">
                    <td style="padding: 10px; font-family: monospace; font-weight: bold;">${escapeHtml(art.stockNumber || doc.id)}</td>
                    <td style="padding: 10px;">${escapeHtml(art.title)}</td>
                    <td style="padding: 10px;">£${Number(art.price).toFixed(2)}</td>
                    <td style="padding: 10px;">${escapeHtml(qtyDisplay)}</td>
                    <td style="padding: 10px; font-size: 0.9em; color: #555;">${escapeHtml(exhibitionsList)}</td>
                    <td style="padding: 10px;">
                        <button type="button" onclick="window.editArtworkRecord('${escapeHtml(doc.id)}')" style="background:#f0ad4e; color:#fff; border:none; padding:5px 10px; cursor:pointer;">Edit</button>
                        <button type="button" onclick="window.deleteArtworkRecord('${escapeHtml(doc.id)}')" style="background:#d9534f; color:#fff; border:none; padding:5px 10px; cursor:pointer; margin-left:5px;">Delete</button>
                    </td>
                </tr>`;
            });
            html += '</table>';
            listContainer.innerHTML = html;

        } catch (error) {
            console.error("Error loading artworks:", error);
            listContainer.innerHTML = '<p style="color: red;">❌ Error loading your artworks. Please refresh and try again.</p>';
        }
    }

    // ---------- UI EVENT HANDLERS ----------
    addBtn.addEventListener('click', () => {
        form.reset();
        document.getElementById('art-stock-number').value = '';
        numberAvailableGroup.style.display = 'none';
        isLimitedCheckbox.checked = false;
        formHeading.innerText = 'Add New Artwork';
        formContainer.style.display = 'block';
        addBtn.style.display = 'none';
        clearValidationErrors();
    });

    cancelBtn.addEventListener('click', () => {
        const hasChanges = Array.from(form.querySelectorAll('input, select, textarea')).some(el => {
            return el.value && el.value.trim().length > 0;
        });
        
        if (hasChanges && !confirm('You have unsaved changes. Are you sure you want to cancel?')) {
            return;
        }
        
        formContainer.style.display = 'none';
        addBtn.style.display = 'block';
        clearValidationErrors();
    });

    function clearValidationErrors() {
        document.querySelectorAll('.validation-error').forEach(el => el.remove());
        document.querySelectorAll('.form-field-error').forEach(el => {
            el.style.borderColor = '';
        });
    }

    function displayValidationErrors(errors) {
        clearValidationErrors();
        
        errors.forEach(error => {
            let fieldId = null;
            if (error.toLowerCase().includes('title')) fieldId = 'art-title';
            else if (error.toLowerCase().includes('price')) fieldId = 'art-price';
            else if (error.toLowerCase().includes('media')) fieldId = 'art-media';
            else if (error.toLowerCase().includes('number available')) fieldId = 'art-number-available';
            
            if (fieldId) {
                const field = document.getElementById(fieldId);
                if (field) {
                    field.style.borderColor = 'red';
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'validation-error';
                    errorDiv.style.cssText = 'color: red; font-size: 0.85em; margin-top: 3px;';
                    errorDiv.innerText = '❌ ' + error;
                    field.parentNode.insertBefore(errorDiv, field.nextSibling);
                }
            }
        });
        
        alert('Please fix the following errors:\n\n' + errors.map(e => '• ' + e).join('\n'));
    }

    // ---------- FORM SUBMIT HANDLER (FIXED: stockNumber variable) ----------
    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        // alert('Step 1: submit called');
        setButtonLoading(submitBtn, true);
        
        try {
            const existingStockNumber = document.getElementById('art-stock-number').value;
            const title = document.getElementById('art-title').value.trim();
            const price = parseFloat(document.getElementById('art-price').value);
            const media = document.getElementById('art-media').value.trim();
            const isLimited = isLimitedCheckbox.checked;
            const numberAvailable = isLimited ? 
                parseInt(document.getElementById('art-number-available').value, 10) : 
                null;

            const selectedExhibitions = [];
            document.querySelectorAll('input[name="exhibitions"]:checked').forEach(cb => {
                selectedExhibitions.push(cb.value);
            });

            // Validate inputs
            const formData = {
                title,
                price,
                media,
                isLimited,
                numberAvailable,
                exhibitions: selectedExhibitions
            };
            
            const validationErrors = validateArtworkForm(formData);
            
            if (validationErrors.length > 0) {
                displayValidationErrors(validationErrors);
                setButtonLoading(submitBtn, false);
                return;
            }

            // ✅ Determine stock number (FIXED)
            let stockNumber = existingStockNumber;
            if (!stockNumber) {
                stockNumber = await generateUniqueStockNumber(db);
                console.log(`✅ Generated new stock number: ${stockNumber}`);
            } else {
                console.log(`✏️ Editing existing artwork: ${stockNumber}`);
            }

            // ✅ Safety check - ensure stockNumber is defined
            if (!stockNumber) {
                throw new Error('Stock number is undefined. Please try again.');
            }

            // Save to Firestore (using artistId - matches your index)
            await db.collection('Catalog').doc(stockNumber).set({  
                stockNumber: stockNumber,
                artistId: wpUser.id,           // ✅ artistId (lowercase 'd')
                artistName: wpUser.name,
                artistEmail: wpUser.email,
                title: title,
                price: price,
                media: media,
                isLimited: isLimited,
                numberAvailable: numberAvailable,
                exhibitions: selectedExhibitions,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            alert('✅ Artwork saved successfully!');
            formContainer.style.display = 'none';
            addBtn.style.display = 'block';
            clearValidationErrors();
            await loadArtistArtworks();
            
        } catch (error) {
            console.error('Error saving artwork:', error);
            alert(`❌ Failed to save artwork: ${error.message || 'Please try again.'}`);
        } finally {
            setButtonLoading(submitBtn, false);
        }
    });

    // ---------- EDIT AND DELETE FUNCTIONS ----------
    window.editArtworkRecord = async function(docId) {
        try {
            const doc = await db.collection('Catalog').doc(docId).get();
            if (!doc.exists) {
                alert('Artwork not found.');
                return;
            }
            
            const data = doc.data();

            document.getElementById('art-stock-number').value = doc.id;
            document.getElementById('art-title').value = data.title || '';
            document.getElementById('art-price').value = data.price || '';
            document.getElementById('art-media').value = data.media || '';
            
            isLimitedCheckbox.checked = !!data.isLimited;
            if (data.isLimited) {
                numberAvailableGroup.style.display = 'block';
                document.getElementById('art-number-available').value = data.numberAvailable !== undefined ? data.numberAvailable : 1;
            } else {
                numberAvailableGroup.style.display = 'none';
            }

            document.querySelectorAll('input[name="exhibitions"]').forEach(cb => {
                cb.checked = data.exhibitions && data.exhibitions.includes(cb.value);
            });

            formHeading.innerText = 'Edit Artwork';
            formContainer.style.display = 'block';
            addBtn.style.display = 'none';
            clearValidationErrors();
            
        } catch (err) {
            console.error("Error loading record for edit:", err);
            alert('❌ Failed to load artwork data. Please try again.');
        }
    };

    window.deleteArtworkRecord = async function(id) {
        if (!confirm('⚠️ Are you sure you want to delete this artwork? This action cannot be undone.')) return;

        try {
            await db.collection('Catalog').doc(id).delete();
            alert('✅ Artwork deleted.');
            await loadArtistArtworks();
        } catch (error) {
            console.error('Error deleting artwork:', error);
            alert('❌ Failed to delete artwork. Please try again.');
        }
    };

    // ---------- UTILITY FUNCTIONS ----------
    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }
}

// ---------- INITIALIZATION ----------
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initArtworkApp);
} else {
    initArtworkApp();
}