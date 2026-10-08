(() => {
  const host = window.location.hostname || 'localhost'
  const protocol = window.location.protocol
  const botPages = { '3110':'bot1', '3112':'WC_Tester', '3114':'bot2', '3116':'official-bot', '3118':'default-bot' }
  const serverLink = document.querySelector('[data-linked-site="server"]')
  const lastBotLink = document.getElementById('lastBotSiteLink')

  function lastBotPort() {
    const item = document.cookie.split(';').map(value => value.trim()).find(value => value.indexOf('yunalinkLastBot=') === 0)
    const port = item ? item.slice('yunalinkLastBot='.length) : ''
    return botPages[port] ? port : '3118'
  }

  async function check(link, url, port) {
    if (!link || !url) return
    link.href = url
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    try {
      const response = await fetch('/api/project/site-status/' + port, { cache:'no-store', signal:controller.signal })
      const status = await response.json()
      const online = response.ok && status.online === true
      link.dataset.state = online ? 'online' : 'offline'
      link.querySelector('.site-state').textContent = online ? 'Online' : 'Offline'
    } catch {
      link.dataset.state = 'offline'
      link.querySelector('.site-state').textContent = 'Offline'
    } finally { clearTimeout(timeout) }
  }

  function refresh() {
    check(serverLink, protocol + '//' + host + ':3101/', 3101)
    const port = lastBotPort()
    if (lastBotLink) {
      lastBotLink.querySelector('.site-copy strong').textContent = botPages[port]
      check(lastBotLink, protocol + '//' + host + ':' + port + '/', port)
    }
  }

  refresh()
  setInterval(refresh, 10000)
})()
