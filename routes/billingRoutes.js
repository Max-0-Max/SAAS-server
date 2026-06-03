const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

/* ── CREATE CHECKOUT SESSION ── */
router.post('/create-checkout-session', authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body;

    const priceId =
      plan === 'enterprise'
        ? process.env.STRIPE_ENTERPRISE_PRICE_ID
        : process.env.STRIPE_PRO_PRICE_ID;

    if (!priceId) return res.status(400).json({ message: 'Invalid plan selected' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.CLIENT_URL}/dashboard?upgraded=true`,
      cancel_url: `${process.env.CLIENT_URL}/pricing`,
      metadata: { userId: String(req.userId), plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ message: 'Failed to create checkout session' });
  }
});

/* ── CREATE CUSTOMER PORTAL SESSION ── */
router.post('/create-portal-session', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user?.stripeCustomerId)
      return res.status(400).json({ message: 'No active subscription found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.CLIENT_URL}/settings`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ message: 'Failed to open billing portal' });
  }
});

/* ── STRIPE WEBHOOK (exported separately for raw body handling in server.js) ── */
const webhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, plan } = session.metadata;
        await User.findByIdAndUpdate(userId, {
          subscription_tier: plan,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
        });
        console.log(`✅ User ${userId} upgraded to ${plan}`);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = await User.findOne({ stripeSubscriptionId: sub.id });
        if (user && sub.status !== 'active') {
          await User.findByIdAndUpdate(user._id, { subscription_tier: 'free' });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await User.findOneAndUpdate(
          { stripeSubscriptionId: sub.id },
          { subscription_tier: 'free', stripeSubscriptionId: null }
        );
        console.log(`⬇️ Subscription cancelled, downgraded to free`);
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
};

module.exports = router;
module.exports.webhook = webhook;
