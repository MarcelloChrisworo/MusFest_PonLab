module.exports = async function sendEmailNotification(notification) {
    const url = process.env.EMAIL_WEBHOOK_URL;
    const secret = process.env.EMAIL_WEBHOOK_SECRET;

    if (process.env.NODE_ENV === 'test' || !url || !secret) {
        return;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...notification, secret })
        });

        const result = await response.json();

        if (!response.ok || result.ok !== true) {
            console.error('Email notification failed:', result.error || response.status);
        }
    } catch (error) {
        console.error('Email notification request failed:', error.message);
    }
};
