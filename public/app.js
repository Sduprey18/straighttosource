const form = document.querySelector('#resolver-form');
const input = document.querySelector('#job-url');
const button = form.querySelector('button');
const message = document.querySelector('#message');
const result = document.querySelector('#result');

form.addEventListener('submit', async event => {
  event.preventDefault();
  result.hidden = true;
  message.className = 'message';
  message.textContent = 'Following the trail…';
  button.disabled = true;
  button.querySelector('span').textContent = 'Looking';

  try {
    const response = await fetch('/api/resolve', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({url:input.value}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    document.querySelector('#result-title').textContent = data.title;
    document.querySelector('#result-host').textContent = data.source;
    document.querySelector('#result-link').href = data.url;
    document.querySelector('#result-action').textContent = 'Open posting';
    result.hidden = false;
    message.textContent = 'Source found.';
  } catch (error) {
    message.className = 'message error';
    message.textContent = error.message || 'Could not resolve that link.';
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Find source';
  }
});
