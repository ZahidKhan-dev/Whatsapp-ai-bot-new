require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

let OpenAI = null;
try {
  OpenAI = require('openai');
} catch (error) {
  console.log('OpenAI package not installed; AI fallback replies will be disabled.');
}

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'pizzabot-data');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const MENU = {
  'classic cheese': {
    name: 'Classic Cheese',
    aliases: ['classic cheese', 'cheese pizza', 'classic pizza'],
    prices: { medium: 900, large: 1400 },
    category: 'pizza'
  },
  pepperoni: {
    name: 'Pepperoni',
    aliases: ['pepperoni'],
    prices: { medium: 1200, large: 1800 },
    category: 'pizza'
  },
  'chicken tikka': {
    name: 'Chicken Tikka',
    aliases: ['chicken tikka', 'tikka pizza', 'chicken pizza'],
    prices: { medium: 1100, large: 1700 },
    category: 'pizza'
  },
  'veggie supreme': {
    name: 'Veggie Supreme',
    aliases: ['veggie supreme', 'veggie pizza', 'vegetable pizza', 'vegetarian pizza'],
    prices: { medium: 1000, large: 1550 },
    category: 'pizza'
  }
};

const DRINKS = {
  pepsi: { name: 'Pepsi 500ml', aliases: ['pepsi', 'pepsi cola'], price: 150 },
  coke: { name: 'Coca-Cola 500ml', aliases: ['coke', 'coca cola', 'coca-cola', 'cola'], price: 150 },
  sprite: { name: 'Sprite 500ml', aliases: ['sprite'], price: 150 },
  fanta: { name: 'Fanta 500ml', aliases: ['fanta', 'orange soda'], price: 150 },
  water: { name: 'Mineral Water 500ml', aliases: ['water', 'mineral water', 'bottled water'], price: 80 }
};

let openai = null;
if (OpenAI && process.env.OPENAI_API_KEY) {
  try {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (error) {
    console.error('Could not initialize OpenAI:', error.message);
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed ?? fallback;
  } catch (error) {
    console.error(`Could not read ${path.basename(file)}:`, error.message);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

let conversations = readJson(CONVERSATIONS_FILE, {});
let orders = readJson(ORDERS_FILE, []);
if (!Array.isArray(orders)) orders = [];

async function saveState(chatId, state) {
  state.updatedAt = new Date().toISOString();
  conversations[chatId] = state;
  writeJsonAtomic(CONVERSATIONS_FILE, conversations);
}

function defaultState() {
  return {
    items: [],
    fulfillment: null,
    address: null,
    stage: 'browsing',
    pendingPizza: null,
    pendingSize: null,
    pendingDrink: null,
    pendingItemType: null,
    pendingRequests: [],
    pendingQuantity: null,
    updatedAt: new Date().toISOString()
  };
}

function getState(chatId) {
  if (!conversations[chatId] || typeof conversations[chatId] !== 'object') {
    conversations[chatId] = defaultState();
  }

  const state = conversations[chatId];
  if (!Array.isArray(state.items)) state.items = [];
  if (!('fulfillment' in state)) state.fulfillment = null;
  if (!('address' in state)) state.address = null;
  if (!('stage' in state)) state.stage = 'browsing';
  if (!('pendingPizza' in state)) state.pendingPizza = null;
  if (!('pendingSize' in state)) state.pendingSize = null;
  if (!('pendingDrink' in state)) state.pendingDrink = null;
  if (!('pendingItemType' in state)) state.pendingItemType = null;
  if (!Array.isArray(state.pendingRequests)) state.pendingRequests = [];
  if (!('pendingQuantity' in state)) state.pendingQuantity = null;

  return state;
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function money(value) {
  return `PKR ${Number(value || 0).toLocaleString('en-PK')}`;
}

function isIslamicGreeting(text) {
  return /^(assalamualaikum|assalamu alaikum|asalam o alaikum|assalam o alaikum|aoa|salam|salaam)$/.test(text);
}

function isGreeting(text) {
  return /^(hi|hello|hey|hy|good morning|good afternoon|good evening|good night)$/.test(text)
    || isIslamicGreeting(text);
}

function isGoodbye(text) {
  return /^(bye|goodbye|good bye|allah hafiz|allah hafiz ji|khuda hafiz|khuda hafiz ji|take care|see you|see you later|talk to you later|good night)$/.test(text);
}

function isReset(text) {
  return /\b(start over|reset order|new order|clear order|start a new order)\b/.test(text);
}

function isCancel(text) {
  return /^(cancel|cancel it|cancel order|cancel my order|cancel this order|stop order)$/.test(text);
}

function isOrderStatusRequest(text) {
  return /\b(status|track|tracking|where|update|delivery status|order status)\b/.test(text)
    && /\b(order|pizza|delivery|it|my)\b/.test(text);
}

function isMenuRequest(text) {
  return /\b(menu|show menu|pizza menu|what pizzas|what do you sell|what do you have)\b/.test(text);
}

function isDrinkMenuRequest(text) {
  return /\b(cold drinks|cold drink|drinks|beverages|soft drinks|soda|what drinks)\b/.test(text);
}

function isAvailabilityQuestion(text) {
  return /\b(open|opening hours|hours|available|availability|open now|discount|discounts|offer|offers|deal|deals|ingredients|allergens|payment|pay|cash|card)\b/.test(text);
}

function isConfirm(text) {
  return /^(yes|yeah|yep|confirm|confirm order|place order|submit order|ok|okay|sure|correct|thats correct|that is correct)$/.test(text);
}

function isReject(text) {
  return /^(no|nope|not now|dont|do not|change it|edit order)$/.test(text);
}

function isDelivery(text) {
  return /\b(delivery|deliver|deliver it|home delivery)\b/.test(text);
}

function isPickup(text) {
  return /\b(pickup|pick up|takeaway|take away|collect)\b/.test(text);
}

function findSize(text) {
  if (/\b(medium|med)\b/.test(text)) return 'medium';
  if (/\b(large|lg|big)\b/.test(text)) return 'large';
  return null;
}

function findQuantity(text) {
  const normalized = normalize(text);
  const match = normalized.match(/^(\d{1,2})$/);

  if (match) {
    const quantity = Number(match[1]);
    return quantity >= 1 && quantity <= 20 ? quantity : null;
  }

  const words = {
    one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10
  };

  return Object.prototype.hasOwnProperty.call(words, normalized) ? words[normalized] : null;
}

function findPizza(text) {
  for (const [key, pizza] of Object.entries(MENU)) {
    if (pizza.aliases.some(alias => text.includes(normalize(alias)))) return key;
  }
  return null;
}

function findDrink(text) {
  for (const [key, drink] of Object.entries(DRINKS)) {
    if (drink.aliases.some(alias => text.includes(normalize(alias)))) return key;
  }
  return null;
}

function menuText() {
  const lines = Object.values(MENU).map(pizza =>
    `• ${pizza.name}: Medium ${money(pizza.prices.medium)} | Large ${money(pizza.prices.large)}`
  );

  return `🍕 *Pizza Menu*\n${lines.join('\n')}\n\nSizes are Medium and Large.`;
}

function drinksText() {
  const lines = Object.values(DRINKS).map(drink =>
    `• ${drink.name}: ${money(drink.price)}`
  );

  return `🥤 *Cold Drinks Menu*\n${lines.join('\n')}\n\nThese are demo prices and can be edited in server.js.`;
}

function subtotal(state) {
  return state.items.reduce((sum, item) => {
    if (item.type === 'drink') {
      const drink = DRINKS[item.drinkKey];
      return sum + (drink ? drink.price * item.quantity : 0);
    }

    const pizza = MENU[item.pizzaKey];
    return sum + (pizza ? pizza.prices[item.size] * item.quantity : 0);
  }, 0);
}

function capitalize(value) {
  return String(value || '').charAt(0).toUpperCase() + String(value || '').slice(1);
}

function summaryText(state) {
  if (!state.items.length) return 'Your order is currently empty.';

  const lines = state.items.map((item, index) => {
    if (item.type === 'drink') {
      const drink = DRINKS[item.drinkKey];
      if (!drink) return null;

      return `${index + 1}. ${drink.name} × ${item.quantity} = ${money(drink.price * item.quantity)}`;
    }

    const pizza = MENU[item.pizzaKey];
    if (!pizza || !pizza.prices[item.size]) return null;

    return `${index + 1}. ${pizza.name} — ${capitalize(item.size)} × ${item.quantity} = ${money(pizza.prices[item.size] * item.quantity)}`;
  }).filter(Boolean);

  return `🧾 *Your order summary*\n${lines.join('\n')}\n\n*Subtotal: ${money(subtotal(state))}*\nDelivery fees and taxes are not configured and are excluded.`;
}

function createOrderId() {
  return `PB-${Math.floor(10000000 + Math.random() * 90000000)}`;
}

async function sendReply(message, text) {
  try {
    await message.reply(text);
  } catch (error) {
    console.error('Failed to send WhatsApp reply:', error.message);
  }
}

async function generateFriendlyReply(userMessage) {
  if (!openai) {
    return 'I can help with our pizza menu, cold drinks, placing an order, or checking a saved demo order. Type *menu* to see pizzas or *cold drinks* to see beverages. 😊';
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You are a friendly WhatsApp assistant for a small pizza shop portfolio demo.
Known pizza menu and demo prices:
${menuText()}
Known cold drinks and demo prices:
${drinksText()}
Do not invent menu items, prices, discounts, business hours, payment methods, delivery times, or real order progress.
If asked about discounts, ingredients, allergens, hours, payments, or anything not provided, politely say that information has not been configured and offer the available menu.
Orders are demo orders stored locally. No kitchen, restaurant, payment, or delivery service is notified.
Be concise, friendly, and use natural WhatsApp wording.`
        },
        { role: 'user', content: userMessage }
      ]
    });

    return response.choices?.[0]?.message?.content?.trim()
      || 'I can help with pizzas, cold drinks, or checking a saved demo order. 😊';
  } catch (error) {
    console.error('OpenAI reply failed:', error.message);
    return 'Sorry, I could not answer that just now. You can type *menu* for pizzas or *cold drinks* for beverages. 😊';
  }
}
function extractLeadingQuantity(text) {
  const m = normalize(text).match(/^\s*(\d{1,2}|one|a|an|two|three|four|five|six|seven|eight|nine|ten)\b/);
  return m ? findQuantity(m[1]) : null;
}

function detectCombinedItems(text) {
  const pizzaKey = findPizza(text);
  const drinkKey = findDrink(text);

  if (!pizzaKey || !drinkKey) return null;

  const normalized = normalize(text);
  const pizzaPosition = normalized.indexOf(normalize(MENU[pizzaKey].name));

  const drinkPosition = Math.max(
    ...DRINKS[drinkKey].aliases.map(alias => normalized.indexOf(normalize(alias)))
  );

  const pizzaSegment = pizzaPosition >= 0
    ? normalized.slice(
        Math.max(0, pizzaPosition - 20),
        drinkPosition > pizzaPosition ? drinkPosition : undefined
      )
    : normalized;

  const drinkSegment = drinkPosition >= 0
    ? normalized.slice(drinkPosition)
    : normalized;

  const pizzaSize = findSize(pizzaSegment);
  const pizzaQuantity = extractLeadingQuantity(pizzaSegment);
  const drinkQuantity = extractLeadingQuantity(drinkSegment);

  return {
    requests: [
      { type: 'pizza', key: pizzaKey, size: pizzaSize, quantity: pizzaQuantity },
      { type: 'drink', key: drinkKey, quantity: drinkQuantity }
    ],
    drinkSizeRequested: /\b(large|medium|small|big)\b/.test(drinkSegment)
  };
}

async function advancePendingRequests(message, state, chatId) {
  while (Array.isArray(state.pendingRequests) && state.pendingRequests.length) {
    const request = state.pendingRequests[0];

    if (request.type === 'pizza') {
      const pizza = MENU[request.key];

      if (!pizza) {
        state.pendingRequests.shift();
        continue;
      }

      if (!request.size) {
        state.pendingPizza = request.key;
        state.pendingSize = null;
        state.pendingQuantity = request.quantity || null;
        state.stage = 'choosing_size';

        await saveState(chatId, state);
        await sendReply(
          message,
          `${pizza.name} is available in Medium (${money(pizza.prices.medium)}) or Large (${money(pizza.prices.large)}). Which size would you like?`
        );
        return;
      }

      if (!request.quantity) {
        state.pendingPizza = request.key;
        state.pendingSize = request.size;
        state.pendingQuantity = null;
        state.stage = 'choosing_quantity';

        await saveState(chatId, state);
        await sendReply(
          message,
          `How many ${capitalize(request.size)} ${pizza.name} pizzas would you like? Please reply with a number from 1 to 20.`
        );
        return;
      }

      state.items.push({
        type: 'pizza',
        pizzaKey: request.key,
        size: request.size,
        quantity: request.quantity
      });

      state.pendingRequests.shift();
      continue;
    }

    if (request.type === 'drink') {
      const drink = DRINKS[request.key];

      if (!drink) {
        state.pendingRequests.shift();
        continue;
      }

      if (!request.quantity) {
        state.pendingDrink = request.key;
        state.stage = 'choosing_drink_quantity';

        await saveState(chatId, state);
        await sendReply(
          message,
          `${drink.name} is available in 500 ml only and costs ${money(drink.price)}. How many would you like? Please reply with a number from 1 to 20.`
        );
        return;
      }

      state.items.push({
        type: 'drink',
        drinkKey: request.key,
        quantity: request.quantity
      });

      state.pendingRequests.shift();
      continue;
    }

    state.pendingRequests.shift();
  }

  state.pendingPizza = null;
  state.pendingSize = null;
  state.pendingDrink = null;
  state.pendingQuantity = null;
  state.stage = 'browsing';

  await saveState(chatId, state);
  await sendReply(
    message,
    `Added to your order! 🍕🥤\n\n${summaryText(state)}\n\nWould you like to add anything else, or choose delivery or pickup?`
  );
}

function findOrderForChat(chatId, text) {
  const idMatch = String(text || '').toUpperCase().match(/\bPB-\d{8}\b/);

  if (idMatch) {
    return orders.find(order =>
      order.id === idMatch[0] && order.chatId === chatId
    ) || null;
  }

  return [...orders].reverse().find(order => order.chatId === chatId) || null;
}

async function handleMessage(message) {
  if (!message || !message.from || message.from === 'status@broadcast') return;
  if (message.fromMe) return;
  if (message.isStatus) return;

  const chatId = message.from;
  const raw = String(message.body || '').trim();

  if (!raw) return;

  const n = normalize(raw);
  const state = getState(chatId);

  if (isGoodbye(n)) {
    await sendReply(
      message,
      'Goodbye! 👋 Allah Hafiz. Thank you for visiting PizzaBot. Have a great day! 🍕'
    );
    return;
  }

  if (isGreeting(n)) {
    await sendReply(
      message,
      isIslamicGreeting(n)
        ? 'Wa Alaikum Assalam! 👋 Welcome to PizzaBot 🍕 I can help with pizzas, cold drinks, and saved demo orders. Type *menu* to get started.'
        : 'Hi there! 👋 Welcome to PizzaBot 🍕 I can help with pizzas, cold drinks, and saved demo orders. Type *menu* to get started.'
    );
    return;
  }

  if (isOrderStatusRequest(n)) {
    const order = findOrderForChat(chatId, raw);

    if (!order) {
      await sendReply(
        message,
        'I could not find a saved order for this WhatsApp chat. If you have an order reference, send it like *PB-12345678*. You can also place a demo order by typing *menu*.'
      );
      return;
    }

    await sendReply(
      message,
      `📦 *Your order status*\n\nOrder reference: ${order.id}\nStatus: ${order.status}\nSubtotal: ${money(order.subtotal)}\n\nThis is a portfolio demo. It does not track real kitchen or delivery progress.`
    );
    return;
  }

  if (isReset(n)) {
    await saveState(chatId, defaultState());
    await sendReply(
      message,
      'I cleared your current draft order. Nothing was submitted. 😊 Type *menu* to start again.'
    );
    return;
  }

  if (isCancel(n)) {
    const hasDraft =
      state.items.length > 0 ||
      state.pendingPizza ||
      state.pendingDrink ||
      state.stage !== 'browsing';

    if (!hasDraft) {
      await sendReply(
        message,
        'There is no active draft order to cancel. Your previously saved demo orders are unchanged.'
      );
      return;
    }

    await saveState(chatId, defaultState());
    await sendReply(
      message,
      'No problem — I cancelled your current draft. Nothing was submitted as an order. Would you like to start a new order?'
    );
    return;
  }

  if (isMenuRequest(n)) {
    await sendReply(message, `${menuText()}\n\nWould you like to order a pizza?`);
    return;
  }

  if (isDrinkMenuRequest(n)) {
    await sendReply(message, `${drinksText()}\n\nWould you like to add a drink to your order?`);
    return;
  }

  if (isAvailabilityQuestion(n)) {
    const reply = await generateFriendlyReply(raw);
    await sendReply(message, reply);
    return;
  }

  // Handle a customer's answer to the pizza size question.
  if (state.stage === 'choosing_size' && state.pendingPizza) {
    const size = findSize(n);

    if (!size) {
      await sendReply(
        message,
        `Please choose *Medium* or *Large* for ${MENU[state.pendingPizza]?.name || 'your pizza'}.`
      );
      return;
    }

    state.pendingSize = size;

    if (state.pendingQuantity) {
      const pizzaKey = state.pendingPizza;
      const quantity = state.pendingQuantity;

      state.pendingRequests = Array.isArray(state.pendingRequests)
        ? state.pendingRequests
        : [];

      if (state.pendingRequests.length && state.pendingRequests[0].type === 'pizza') {
        state.pendingRequests[0].size = size;
        state.pendingRequests[0].quantity = quantity;
      } else {
        state.items.push({
          type: 'pizza',
          pizzaKey,
          size,
          quantity
        });
      }

      state.pendingPizza = null;
      state.pendingSize = null;
      state.pendingQuantity = null;

      await advancePendingRequests(message, state, chatId);
      return;
    }

    state.stage = 'choosing_quantity';
    await saveState(chatId, state);

    const pizza = MENU[state.pendingPizza];

    await sendReply(
      message,
      `Great! How many ${capitalize(size)} ${pizza.name} pizzas would you like? Please reply with a number from 1 to 20.`
    );
    return;
  }

  // Handle a customer's answer to the pizza quantity question.
  // Handle a customer's answer to the pizza quantity question.
  if (state.stage === 'choosing_quantity' && state.pendingPizza && state.pendingSize) {
    const quantity = findQuantity(n);

    if (!quantity) {
      await sendReply(
        message,
        'How many would you like? Please enter a whole number from 1 to 20.'
      );
      return;
    }

    if (
      !MENU[state.pendingPizza] ||
      !['medium', 'large'].includes(state.pendingSize)
    ) {
      state.pendingPizza = null;
      state.pendingSize = null;
      state.pendingQuantity = null;
      state.stage = 'browsing';

      await saveState(chatId, state);
      await sendReply(
        message,
        'Your previous pizza selection expired. Please type *menu* and choose again.'
      );
      return;
    }

    if (
      Array.isArray(state.pendingRequests) &&
      state.pendingRequests.length > 0 &&
      state.pendingRequests[0].type === 'pizza'
    ) {
      // Keep the pizza in the queue until advancePendingRequests processes it.
      state.pendingRequests[0].size = state.pendingSize;
      state.pendingRequests[0].quantity = quantity;
    } else {
      state.items.push({
        type: 'pizza',
        pizzaKey: state.pendingPizza,
        size: state.pendingSize,
        quantity
      });
    }

    state.pendingPizza = null;
    state.pendingSize = null;
    state.pendingQuantity = null;

    if (
      Array.isArray(state.pendingRequests) &&
      state.pendingRequests.length > 0
    ) {
      await advancePendingRequests(message, state, chatId);
      return;
    }

    state.stage = 'browsing';
    await saveState(chatId, state);

    await sendReply(
      message,
      `Added to your order! 🍕\n\n${summaryText(state)}\n\nWould you like to add another pizza or a cold drink, or choose delivery or pickup?`
    );
    return;
  }

  // Handle a customer's answer to the drink quantity question.
  if (state.stage === 'choosing_drink_quantity' && state.pendingDrink) {
    const quantity = findQuantity(n);

    if (!quantity) {
      await sendReply(
        message,
        'How many drinks would you like? Please enter a whole number from 1 to 20.'
      );
      return;
    }

    const drink = DRINKS[state.pendingDrink];

    if (!drink) {
      state.pendingDrink = null;
      state.stage = 'browsing';

      await saveState(chatId, state);
      await sendReply(
        message,
        'That drink selection is no longer available. Type *cold drinks* to see the list.'
      );
      return;
    }

    if (
      Array.isArray(state.pendingRequests) &&
      state.pendingRequests.length &&
      state.pendingRequests[0].type === 'drink'
    ) {
      state.pendingRequests[0].quantity = quantity;
      state.pendingRequests.shift();
    } else {
      state.items.push({
        type: 'drink',
        drinkKey: state.pendingDrink,
        quantity
      });
    }

    state.pendingDrink = null;

    if (state.pendingRequests.length) {
      await advancePendingRequests(message, state, chatId);
      return;
    }

    state.stage = 'browsing';
    await saveState(chatId, state);

    await sendReply(
      message,
      `Added to your order! 🥤\n\n${summaryText(state)}\n\nWould you like to add anything else, or choose delivery or pickup?`
    );
    return;
  }
  // Collect delivery address.
  if (state.stage === 'awaiting_address') {
    if (n.length < 5) {
      await sendReply(
        message,
        'Please send a more complete delivery address, or type *pickup* if you prefer to collect your order.'
      );
      return;
    }

    state.address = raw;
    state.stage = 'awaiting_confirmation';

    await saveState(chatId, state);
    await sendReply(
      message,
      `${summaryText(state)}\nFulfilment: Delivery\nAddress: ${state.address}\n\nShould I save this demo order? Reply *Yes* to confirm or *Cancel* to discard the draft.`
    );
    return;
  }

  // Save or discard the draft order.
  if (state.stage === 'awaiting_confirmation') {
    if (isConfirm(n)) {
      if (!state.items.length) {
        await saveState(chatId, defaultState());
        await sendReply(
          message,
          'Your draft is empty, so I did not create an order. Type *menu* to start again.'
        );
        return;
      }

      const order = {
        id: createOrderId(),
        chatId,
        items: state.items.map(item => {
          if (item.type === 'drink') {
            const drink = DRINKS[item.drinkKey];
            return { ...item, drink: drink.name, unitPrice: drink.price };
          }

          const pizza = MENU[item.pizzaKey];
          return { ...item, pizza: pizza.name, unitPrice: pizza.prices[item.size] };
        }),
        fulfillment: state.fulfillment,
        address: state.fulfillment === 'delivery' ? state.address : null,
        subtotal: subtotal(state),
        currency: 'PKR',
        status: 'confirmed_demo_order',
        createdAt: new Date().toISOString()
      };

      orders.push(order);
      writeJsonAtomic(ORDERS_FILE, orders);

      // A confirmed order starts a fresh draft.
      await saveState(chatId, defaultState());

      await sendReply(
        message,
        `Thank you! Your demo order has been recorded. 🍕\nOrder reference: ${order.id}\nSubtotal: ${money(order.subtotal)}\n\nThis is a portfolio demo. No restaurant, kitchen, payment, or delivery service has been notified.`
      );
      return;
    }

    if (isReject(n) || isCancel(n)) {
      await saveState(chatId, defaultState());
      await sendReply(
        message,
        'I discarded the draft. No order was saved. Type *menu* whenever you would like to start again.'
      );
      return;
    }

    await sendReply(
      message,
      'Please reply *Yes* to save this demo order, or *Cancel* to discard it.'
    );
    return;
  }

  // Select delivery or pickup after adding items.
  if (isDelivery(n) || isPickup(n)) {
    if (!state.items.length) {
      await sendReply(
        message,
        'Your order is empty. Type *menu* to choose a pizza, or *cold drinks* to choose a drink first.'
      );
      return;
    }

    state.fulfillment = isDelivery(n) ? 'delivery' : 'pickup';

    if (state.fulfillment === 'delivery') {
      state.stage = 'awaiting_address';
      await saveState(chatId, state);

      await sendReply(
        message,
        `Please send your delivery address. After that, I will show the final summary for confirmation.\n\n${summaryText(state)}`
      );
      return;
    }

    state.address = null;
    state.stage = 'awaiting_confirmation';

    await saveState(chatId, state);
    await sendReply(
      message,
      `${summaryText(state)}\nFulfilment: Pickup\n\nShould I save this demo order? Reply *Yes* to confirm or *Cancel* to discard the draft.`
    );
    return;
  }

  if (isConfirm(n) && state.items.length && state.stage === 'browsing') {
    await sendReply(
      message,
      'Your items are in the draft. Please choose *Delivery* or *Pickup* before confirming.'
    );
    return;
  }

  // Recognize a pizza and a drink in the same message.
  const combined = detectCombinedItems(n);

  if (combined) {
    state.pendingRequests = combined.requests;
    state.pendingPizza = null;
    state.pendingSize = null;
    state.pendingDrink = null;
    state.pendingQuantity = null;

    const pizza = MENU[combined.requests[0].key];
    const drink = DRINKS[combined.requests[1].key];

    state.stage = 'choosing_size';
    state.pendingPizza = combined.requests[0].key;
    state.pendingQuantity = combined.requests[0].quantity || null;

    await saveState(chatId, state);

    const drinkNote = combined.drinkSizeRequested
      ? `Note: ${drink.name} is available in 500 ml only. `
      : '';

    await sendReply(
      message,
      `${drinkNote}I found ${pizza.name} and ${drink.name} in your message. Let's add both. ${pizza.name} is available in Medium (${money(pizza.prices.medium)}) or Large (${money(pizza.prices.large)}). Which pizza size would you like?`
    );
    return;
  }

  // Add a drink.
  const drinkKey = findDrink(n);

  if (drinkKey) {
    state.pendingDrink = drinkKey;
    state.stage = 'choosing_drink_quantity';

    await saveState(chatId, state);
    await sendReply(
      message,
      `${DRINKS[drinkKey].name} costs ${money(DRINKS[drinkKey].price)}. How many would you like? Please reply with a number from 1 to 20.`
    );
    return;
  }

  // Add a pizza.
  const pizzaKey = findPizza(n);

  if (pizzaKey) {
    const size = findSize(n);
    const quantity = extractLeadingQuantity(n);

    state.pendingPizza = pizzaKey;
    state.pendingSize = null;
    state.pendingDrink = null;
    state.pendingQuantity = quantity || null;

    if (size) {
      state.pendingSize = size;
      state.stage = 'choosing_quantity';

      await saveState(chatId, state);
      await sendReply(
        message,
        `Sure! ${MENU[pizzaKey].name} ${capitalize(size)} costs ${money(MENU[pizzaKey].prices[size])}. How many would you like? Please reply with a number from 1 to 20.`
      );
      return;
    }

    state.stage = 'choosing_size';
    await saveState(chatId, state);

    await sendReply(
      message,
      `Sure! 😊 ${MENU[pizzaKey].name} is available in Medium (${money(MENU[pizzaKey].prices.medium)}) or Large (${money(MENU[pizzaKey].prices.large)}). Which size would you like?`
    );
    return;
  }

  if (/\b(pizza|pizzas)\b/.test(n) && findSize(n)) {
    await sendReply(message, `Which pizza would you like?\n\n${menuText()}`);
    return;
  }

  if (/\b(add|order|want|have|get)\b/.test(n) &&
      /\b(drink|pepsi|coke|cola|sprite|fanta|water)\b/.test(n)) {
    await sendReply(message, drinksText());
    return;
  }

  if (state.items.length &&
      /\b(summary|total|subtotal|my order|show order)\b/.test(n)) {
    await sendReply(message, summaryText(state));
    return;
  }

  const reply = await generateFriendlyReply(raw);
  await sendReply(message, reply);
}

// Prevent simultaneous messages from updating one chat's draft together.
const chatQueues = new Map();
const seenMessageIds = new Set();

function queueMessage(message) {
  const messageId = message?.id?._serialized;

  if (messageId && seenMessageIds.has(messageId)) return;

  if (messageId) {
    seenMessageIds.add(messageId);

    if (seenMessageIds.size > 5000) {
      const first = seenMessageIds.values().next().value;
      seenMessageIds.delete(first);
    }
  }

  const chatId = message.from;
  const previous = chatQueues.get(chatId) || Promise.resolve();

  const next = previous
    .catch(error => console.error('Previous message handler failed:', error.message))
    .then(() => handleMessage(message))
    .catch(error => console.error('Message handler failed:', error.stack || error.message));

  chatQueues.set(chatId, next);

  next.finally(() => {
    if (chatQueues.get(chatId) === next) {
      chatQueues.delete(chatId);
    }
  });
}

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, 'whatsapp-session')
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => {
  console.log('\nScan this QR code with WhatsApp > Linked devices:\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('WhatsApp authenticated.');
});

client.on('auth_failure', message => {
  console.error('WhatsApp authentication failure:', message);
});

client.on('ready', () => {
  console.log('WhatsApp connected successfully! Bot is ready.');
});

client.on('disconnected', reason => {
  console.log('WhatsApp disconnected:', reason);
});

client.on('message', queueMessage);

// Health-check server.
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'PizzaBot demo',
      whatsappReady: Boolean(client.info),
      openaiEnabled: Boolean(openai)
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('PizzaBot demo is running. Visit /health for status.');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Health server listening on port ${PORT}`);
  console.log(
    `OpenAI replies: ${openai ? 'enabled' : 'disabled (set OPENAI_API_KEY in .env)'}`
  );
});

client.initialize();

process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error?.stack || error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error?.stack || error);
});