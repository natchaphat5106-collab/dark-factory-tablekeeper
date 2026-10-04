const API = '';  // relative — proxy at :8080 forwards to :3000
let restaurantId = null;
let tableId = null;
let lastBookingId = null;

const $ = (id) => document.getElementById(id);

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  let data = null;
  if (res.status !== 204) { try { data = await res.json(); } catch {} }
  return { status: res.status, data };
}

function setStatus(msg, kind = 'info') {
  const el = $('booking-status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

$('create-restaurant').onclick = async () => {
  setStatus('Creating...', 'pending');
  const { status, data } = await api('POST', '/v1/restaurants', {
    name: 'Demo', timezone: 'Asia/Bangkok'
  });
  if (status === 201) {
    restaurantId = data.id;
    $('setup-output').textContent = JSON.stringify(data, null, 2);
    $('create-table').disabled = false;
    setStatus('✅ Restaurant created.', 'success');
  } else {
    setStatus(`❌ ${data?.error?.message || status}`, 'error');
  }
};

$('create-table').onclick = async () => {
  if (!restaurantId) return;
  setStatus('Creating table...', 'pending');
  const { status, data } = await api('POST', `/v1/restaurants/${restaurantId}/tables`, {
    seats: 4
  });
  if (status === 201) {
    tableId = data.id;
    $('setup-output').textContent = JSON.stringify(data, null, 2);
    $('book-btn').disabled = false;
    setStatus('✅ Table created.', 'success');
  } else {
    setStatus(`❌ ${data?.error?.message || status}`, 'error');
  }
};

$('booking-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!restaurantId || !tableId) return;
  const date = $('date').value;
  const time = $('time').value;
  const partySize = parseInt($('party-size').value, 10);
  const duration = parseInt($('duration').value, 10);
  setStatus('Booking...', 'pending');
  const { status, data } = await api('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: partySize,
    local_start: `${date}T${time}`,
    duration_min: duration,
    idempotency_key: `web-${Date.now()}`,
  });
  $('booking-output').textContent = JSON.stringify({ status, ...data }, null, 2);
  if (status === 201 || status === 200) {
    lastBookingId = data.id;
    $('cancel-btn').disabled = false;
    setStatus(`✅ Booked (status ${status})`, 'success');
  } else if (status === 409) {
    setStatus('❌ Slot already taken', 'error');
  } else if (status === 400) {
    setStatus(`❌ ${data?.error?.message || 'Bad request'}`, 'error');
  } else {
    setStatus(`❌ ${data?.error?.message || status}`, 'error');
  }
};

$('cancel-btn').onclick = async () => {
  if (!lastBookingId) return;
  setStatus('Cancelling...', 'pending');
  const { status, data } = await api('DELETE', `/v1/bookings/${lastBookingId}`);
  if (status === 204) {
    setStatus('✅ Cancelled', 'success');
    $('booking-output').textContent = JSON.stringify({ status: 204 }, null, 2);
    lastBookingId = null;
    $('cancel-btn').disabled = true;
  } else {
    setStatus(`❌ ${data?.error?.message || status}`, 'error');
  }
};

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
$('date').value = tomorrow.toISOString().slice(0, 10);
$('time').value = '19:00';
