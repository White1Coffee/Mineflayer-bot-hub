let state = { bots: [] }
    let health = null
    let discord = null
    let lastMergedFolder = ''
    let viewerRenderKey = ''
    const loadedViewers = new Set()
    const hubChatLines = []
    const mergeTargets = new Map()
    let dashboard = { overview:null,skills:[],experiences:[],logistics:{containers:[],reservations:[],botInventories:[]},events:[],schematics:[],schematicBuilds:[],reconnects:{bots:[],servers:[]} }
    let dashboardStream = null
    let settingsIntegrations = null
    let dashboardRefreshTimer = null
    let lastDashboardDetailsAt = 0
    let refreshInFlight = false
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]))
    const coordinate = value => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '-'
    const botName = botId => state.bots.find(bot => bot.id === botId)?.name || dashboard.overview?.bots?.find(bot => bot.botId === botId)?.displayName || botId || 'Unassigned'
    const worldName = worldId => {
      const teamBot = (state.team?.bots || []).find(bot => bot.worldId === worldId)
      const dashboardBot = (dashboard.overview?.bots || []).find(bot => bot.worldId === worldId)
      const server = teamBot?.minecraft || dashboardBot?.server
      return server?.host ? `${server.host}${server.port ? `:${server.port}` : ''}` : worldId || 'Unknown server'
    }
    function addPanelInformation() {
      const information = {
        'All bots':'Live status, gezondheid, positie en huidige werkzaamheden van alle geconfigureerde bots.',
        'Live bot details':'Task is de hoofdopdracht, Skill is de actieve vaardigheid en Retry toont de huidige herstelpoging.',
        'Bot command access':'Owner is de hoofdbeheerder. Whitelisted players mogen eveneens chatcommando’s geven aan alleen die bot.',
        'Build status':'Hier staat of de bot de opdracht echt heeft uitgevoerd en, bij mislukking, waarom hij is gestopt.',
        'Obtain iron ingots':'Kies een server, hoeveelheid en logistieke kist; de Hub maakt en verdeelt daarna de subtaken.',
        'Active bots':'Bots die live bij de teamcoördinator geregistreerd zijn. Heartbeat toont hoe recent hun status is ontvangen.',
        'Goals':'Gezamenlijke opdrachten. De voortgang stijgt alleen door gevalideerde, voltooide subtaken.',
        'Tasks and reservations':'Een reservering voorkomt dat twee bots dezelfde taak, werkplek of container tegelijk gebruiken.',
        'Verified inventory':'Voorraad die door een bot in een echte container is gecontroleerd.',
        'available':'Wacht op een geschikte beschikbare bot.',
        'reserved':'Tijdelijk aangeboden aan één bot; de bot moet de taak nog accepteren.',
        'assigned':'Geaccepteerd en klaar om lokaal te starten.',
        'running':'Wordt momenteel door de toegewezen bot uitgevoerd.',
        'blocked':'Kan tijdelijk niet verder door gevaar, materiaaltekort of een andere fout.',
        'completed':'Succes is door de echte speltoestand gevalideerd.',
        'failed':'Definitief mislukt nadat de toegestane retries zijn gebruikt.',
        'cancelled':'Handmatig of door een bovenliggende opdracht gestopt.',
        'Skills & Learning':'Alleen echte uitvoeringen tellen mee voor succespercentage, duur en foutstatistieken.',
        'Recent experiences':'Opgeslagen lessen uit relevante successen en mislukkingen; identieke fouten worden gededupliceerd.',
        'Bot inventories':'Live samenvatting van wat iedere bot bij zich draagt.',
        'Verified containers':'Werkelijke kist- of oveninhoud bij de laatste controle door een bot.',
        'Reservations':'Materialen die tijdelijk voor een taak zijn apart gehouden en dus niet vrij beschikbaar zijn.',
        'Dashboard configuration':'Realtime bestuurt live updates, Debug toont technische details en Control actions staat bediening toe.',
        'Select bots':'Selecteer minimaal twee gestopte bots om hun kennis veilig in een nieuwe map te combineren.',
        'Merged knowledge':'Pas gecombineerde kennis toe op gestopte bots; voor iedere doelbot wordt eerst een backup gemaakt.'
      }
      for (const heading of document.querySelectorAll('.tab h2')) {
        const title = heading.textContent.replace(/\s+\d+$/, '').trim()
        const text = information[title]
        if (!text || heading.parentElement.querySelector(':scope > .block-info, :scope > p')) continue
        const description = document.createElement('p')
        description.className = 'block-info'
        description.textContent = text
        heading.insertAdjacentElement('afterend', description)
      }
    }
    const amsterdamTime = value => new Intl.DateTimeFormat('nl-NL', {
      timeZone:'Europe/Amsterdam',
      hour:'2-digit',
      minute:'2-digit',
      second:'2-digit',
      hour12:false
    }).format(value ? new Date(value) : new Date())

    function currentDashboardToken() {
      try { return sessionStorage.getItem('dashboardToken') || '' } catch { return '' }
    }

    async function api(url, options = {}) {
      const token = currentDashboardToken()
      const response = await fetch(url, {
        ...options,
        headers: { 'Content-Type':'application/json', ...(token ? { 'X-Dashboard-Token':token } : {}), ...(options.headers || {}) }
      })
      const text = await response.text()
      let result
      try {
        result = text ? JSON.parse(text) : {}
      } catch {
        throw new Error('Hub API returned HTML instead of JSON. Restart the Hub with Start.cmd so the new backend is active.')
      }
      if (!response.ok || result.ok === false) throw new Error(result.error || 'Hub request failed.')
      return result
    }

    function notify(message, bad = false) {
      const status = document.getElementById('hubStatus')
      status.textContent = message
      status.parentElement.style.color = bad ? 'var(--red)' : 'var(--green)'
      clearTimeout(notify.timer)
      notify.timer = setTimeout(() => {
        status.textContent = 'Hub online'
        status.parentElement.style.color = 'var(--green)'
      }, 5000)
    }

    function localServiceUrl(port) {
      const host = location.hostname || 'localhost'
      return `http://${host}:${port}`
    }

    function renderTopStatus() {
      const onlineBots = (state.bots || []).filter(bot => bot.telemetry?.connected || bot.status?.running).length
      const botsChip = document.getElementById('botsTopStatus')
      const discordChip = document.getElementById('discordTopStatus')
      botsChip.textContent = `${onlineBots} / ${(state.bots || []).length} bots online`
      botsChip.classList.toggle('online', onlineBots > 0)
      const bridge = state.discordBridge || discord
      const discordOnline = Boolean(bridge?.running)
      discordChip.textContent = discordOnline ? `Discord online${bridge.pid ? ` (${bridge.pid})` : ''}` : 'Discord offline'
      discordChip.classList.toggle('online', discordOnline)
      discordChip.classList.toggle('bad', !discordOnline)
    }

    function botCard(bot) {
      const status = bot.status || {}
      const paused = status.pausedMs > 0
      const label = paused ? 'Paused' : (status.running ? (status.managed ? 'Running' : 'HUD online') : 'Stopped')
      const statusClass = paused ? 'external' : (status.running ? (status.managed ? 'online' : 'external') : '')
      const versionOptions = minecraftVersionOptions(bot.version)
      return `<article class="bot-card" data-id="${esc(bot.id)}">
        <div class="card-head">
          <div><h2>${esc(bot.name)}</h2><p>${esc(bot.folder)}</p></div>
          <span class="pill ${statusClass}"><i class="dot"></i>${label}</span>
        </div>
        <div class="fields">
          <label class="wide">Display name<input data-field="name" value="${esc(bot.name)}"></label>
          <label>Minecraft username<input value="${esc(bot.username)}" readonly title="Wordt bij opslaan gelijkgemaakt aan de display name (maximaal 16 tekens)."></label>
          <label>Minecraft version<select data-field="version">${versionOptions}</select></label>
          <label>Server host<input data-field="host" value="${esc(bot.host)}"></label>
          <label>Server port<input data-field="port" type="number" min="1" max="65535" value="${esc(bot.port)}"></label>
          <label>HUD port<input data-field="hudPort" type="number" min="1" max="65535" value="${esc(bot.hudPort)}"></label>
          <label>Viewer port<input data-field="viewerPort" type="number" min="1" max="65535" value="${esc(bot.viewerPort)}"></label>
          <label>Group<select data-field="group">${[...new Set([...(state.groups || []), bot.group || 'Ungrouped'])].map(group => `<option ${group === bot.group ? 'selected' : ''}>${esc(group)}</option>`).join('')}</select></label>
          <label>Auto restart<select data-field="autoRestart"><option value="true" ${bot.autoRestart ? 'selected' : ''}>Enabled</option><option value="false" ${!bot.autoRestart ? 'selected' : ''}>Disabled</option></select></label>
        </div>
        <div class="links">
          <a href="${esc(localServiceUrl(bot.hudPort))}" target="_blank" rel="noopener">Open dashboard</a>
          <a href="${esc(localServiceUrl(bot.viewerPort))}" target="_blank" rel="noopener">Open viewer</a>
        </div>
        <div class="actions">
          <button type="button" data-action="start" ${status.running || paused ? 'disabled' : ''}>Turn on</button>
          <button type="button" data-action="stop" class="secondary" ${status.running ? '' : 'disabled'}>Stop</button>
          <button type="button" data-action="save" class="secondary" ${status.managed ? 'disabled' : ''}>Save</button>
          <button type="button" data-action="folder" class="secondary">Open folder</button>
          <button type="button" data-action="remove" class="danger" ${status.running ? 'disabled' : ''}>Remove</button>
        </div>
        <p>Starts: ${bot.stats?.starts || 0} | Crashes: ${bot.stats?.crashes || 0} | Runtime: ${Math.round((bot.stats?.totalRuntimeMs || 0) / 60000)} min${bot.stats?.lastError ? ` | Last error: ${esc(bot.stats.lastError)}` : ''}</p>
      </article>`
    }

    function minecraftVersionOptions(selected = '') {
      const versions = state.supportedMinecraftVersions || ['1.21.4']
      return versions.map(version => `<option value="${esc(version)}" ${version === selected ? 'selected' : ''}>${esc(version)}</option>`).join('')
    }

    function renderBots() {
      if (document.activeElement?.closest?.('.bot-card')) return
      document.getElementById('botGrid').innerHTML = state.bots.length
        ? state.bots.map(botCard).join('')
        : '<div class="empty">No bot folders registered.</div>'
      renderBotAccess()
    }

    function renderBotAccess(){const target=document.getElementById('botAccessList');if(document.activeElement?.closest?.('.bot-access-form'))return;target.innerHTML=(state.bots||[]).map(bot=>`<form class="manage-block stack bot-access-form" data-bot-id="${esc(bot.id)}"><h2>${esc(bot.name)}</h2><p>Minecraft username: <strong>${esc(bot.username)}</strong>${bot.status?.running?' · online wijzigingen worden direct doorgestuurd':''}</p><label>Owner<input name="ownerPlayer" maxlength="16" value="${esc(bot.ownerPlayer||'')}" placeholder="Exacte Minecraft-naam"></label><label>Whitelisted players<textarea name="whitelistedPlayers" rows="4" placeholder="Eén naam per regel">${esc((bot.whitelistedPlayers||[]).join('\n'))}</textarea></label><button type="submit">Save command access</button><span class="broadcast-status"></span></form>`).join('')||'<div class="empty">No bots configured.</div>'}

    function renderOverview() {
      if (document.activeElement?.closest?.('.bot-send')) return
      document.getElementById('overviewCount').textContent = `${state.bots.length} bot${state.bots.length === 1 ? '' : 's'}`
      if (!state.bots.length) {
        document.getElementById('overviewTable').innerHTML = '<div class="empty">No bot folders registered.</div>'
        return
      }
      const meter = value => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1).replace('.0', '')} / 20` : '-'
      const rows = state.bots.map(bot => {
        const data = bot.telemetry
        const position = data?.position ? `${coordinate(data.position.x)}, ${coordinate(data.position.y)}, ${coordinate(data.position.z)}` : '-'
        const connection = data ? (data.connected ? 'ONLINE' : 'OFFLINE') : (bot.status?.hudOnline ? 'HUD ONLY' : 'OFFLINE')
        const connectionClass = data?.connected ? 'value-good' : 'value-bad'
        const teamBot=dashboard.overview?.bots?.find(item=>item.botId===bot.id)
        return `<tr>
          <td><strong>${esc(bot.name)}</strong><br><a href="${esc(localServiceUrl(bot.hudPort))}" target="_blank" rel="noopener">Open dashboard</a></td>
          <td>${esc(data?.username || '-')}</td>
          <td>${meter(data?.health)}</td>
          <td>${meter(data?.food)}</td>
          <td>${esc(data?.mode || '-')}</td>
          <td>${data ? (data.autonomy ? 'ON' : 'OFF') : '-'}</td>
          <td>${data ? (data.pvp ? 'ON' : 'OFF') : '-'}</td>
          <td>${data?.xp ?? '-'}</td>
          <td>${esc(position)}</td>
          <td>${esc(teamBot?.currentTask?.detail || teamBot?.currentTask || '-')}</td>
          <td>${esc(teamBot?.activeSkill||'-')}</td>
          <td>${esc(teamBot?.lastError||'-')}</td>
          <td>${teamBot?.heartbeatAgeMs==null?'-':`${Math.round(teamBot.heartbeatAgeMs/1000)}s`}</td>
          <td class="${connectionClass}">${connection}</td>
          <td><form class="bot-send" data-bot-id="${esc(bot.id)}"><input placeholder="Chat or AI command" ${data?.connected ? '' : 'disabled'}><button type="submit" ${data?.connected ? '' : 'disabled'}>Send</button></form></td>
        </tr>`
      }).join('')
      document.getElementById('overviewTable').innerHTML = `<table>
        <thead><tr><th>Bot</th><th>Username</th><th>HP</th><th>Food</th><th>Mode</th><th>Autonomy</th><th>PvP</th><th>XP</th><th>Position</th><th>Task</th><th>Skill</th><th>Error</th><th>Heartbeat</th><th>Connection</th><th>Message / command</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    }

    function renderTeam() {
      const team=state.team||{bots:[],goals:[],tasks:[],reservations:[],inventory:{containers:{}}};const worlds=[...new Set((team.bots||[]).filter(bot=>bot.online).map(bot=>bot.worldId))]
      const worldSelect=document.getElementById('teamWorld');const selected=worldSelect.value;worldSelect.innerHTML=worlds.map(world=>`<option value="${esc(world)}" ${world===selected?'selected':''}>${esc(worldName(world))}</option>`).join('')||'<option value="">No online team worlds</option>'
      document.getElementById('teamBots').innerHTML=(team.bots||[]).map(bot=>`<div class="item team-bot-row"><strong class="bot-display-name">${esc(botName(bot.botId))}</strong><span class="pill ${bot.online?'online':''}">${bot.online?'ONLINE':'OFFLINE'}</span><small class="team-bot-meta">${esc(bot.currentSkill||bot.state||'idle')} · ${esc(worldName(bot.worldId))} · heartbeat ${Math.max(0,Math.round((Date.now()-Number(bot.lastHeartbeatAt||0))/1000))}s ago</small></div>`).join('')||'<div class="empty">No team clients registered.</div>'
      const goals=dashboard.goals||dashboard.overview?.goals||team.goals||[]
      document.getElementById('teamGoals').innerHTML=goals.map(goal=>`<div class="item"><strong>${esc(goal.title||goal.type)} · ${esc(goal.requirements?.iron_ingot||'')}</strong><span class="pill">${esc(goal.status)}</span><div class="meter" title="Validated completed subtasks"><span style="width:${Math.round(Number(goal.progress||0)*100)}%"></span></div><small>${Math.round(Number(goal.progress||0)*100)}% · ${esc(goal.id)} · ${esc(goal.assignedBots?.join(', ')||'no owners')}</small><p>${Object.entries(goal.requirements||{}).map(([item,needed])=>`${esc(item)}: ${goal.collected?.[item]||0}/${needed} verified`).join(' · ')||'No material requirement'}<br>Remaining validated steps: ${esc(goal.estimatedRemainingSteps??'-')}</p>${(goal.blockers||[]).map(b=>`<span class="value-bad">${esc(b.taskId)}: ${esc(b.errorCode||'blocked')}</span>`).join('')}<div class="inline"><input data-goal-priority="${esc(goal.id)}" type="number" min="0" max="100" value="${esc(goal.priority)}" title="Goal priority"><button data-save-goal-priority="${esc(goal.id)}" class="secondary">Set priority</button>${goal.status==='blocked'?`<button data-goal-action="resume" data-goal-id="${esc(goal.id)}">Resume</button>`:`<button data-goal-action="pause" data-goal-id="${esc(goal.id)}" class="secondary">Pause</button>`}<button data-goal-action="replan" data-goal-id="${esc(goal.id)}" class="secondary">Replan</button><button data-goal-action="cancel" data-goal-id="${esc(goal.id)}" class="danger">Cancel</button></div></div>`).join('')||'<div class="empty">No team goals.</div>'
      document.getElementById('teamTasks').innerHTML=(team.tasks||[]).map(task=>`<div class="item"><strong>${esc(task.skill)}</strong><span class="pill">${esc(task.status)}</span><small>${esc(botName(task.assignedBotId))} ${task.lastError?`· ${esc(task.lastError)}`:''}</small>${!['completed','cancelled'].includes(task.status)?`<button data-cancel-team-task="${esc(task.id)}" class="secondary">Cancel</button>`:''}</div>`).join('')||'<div class="empty">No tasks.</div>'
      document.getElementById('teamReservations').innerHTML=`<p>${(team.reservations||[]).length} active reservations</p>`
      document.getElementById('teamInventory').innerHTML=Object.values(team.inventory?.containers||{}).map(container=>`<div class="item"><strong>${esc(container.id)}</strong><small>${Object.entries(container.contents||{}).map(([name,count])=>`${esc(name)}: ${count}`).join(', ')||'empty'}</small></div>`).join('')||'<div class="empty">No verified logistics containers.</div>'
    }

    function metric(label,value,detail=''){return `<div class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`}
    function renderDashboard(){const overview=dashboard.overview;if(!overview)return;const c=overview.counts||{};document.getElementById('dashboardMetrics').innerHTML=[metric('Online bots',c.onlineBots),metric('Offline bots',c.offlineBots),metric('Idle bots',c.idleBots),metric('Active tasks',c.activeTasks),metric('Blocked tasks',c.blockedTasks),metric('Active goals',c.activeGoals),metric('Known skills',c.knownSkills),metric('Average success',overview.averageSkillSuccessRate==null?'Insufficient data':`${Math.round(overview.averageSkillSuccessRate*100)}%`)].join('');document.getElementById('dashboardWarnings').innerHTML=(overview.warnings||[]).map(w=>`<div class="notice warning">⚠ ${esc(w)}</div>`).join('');renderReconnectCharts();renderBotDetails();renderTaskBoard();renderLearning();renderLogistics();renderSchematics();renderEvents();renderDashboardSettings();addPanelInformation()}
    function renderReconnectCharts(){const render=(id,groups)=>{const target=document.getElementById(id),maximum=Math.max(1,...(groups||[]).map(group=>Number(group.total||0)));target.innerHTML=(groups||[]).map(group=>`<div class="reconnect-chart"><strong>${esc(group.label)}</strong><div class="reconnect-track" title="${esc(group.total)} reconnects in 7 days"><span style="width:${Math.max(2,Math.round(Number(group.total||0)/maximum*100))}%"></span></div><small>${esc(group.total)}×</small></div>`).join('')||'<div class="empty">Nog geen reconnects gemeten.</div>'};render('reconnectBotCharts',dashboard.reconnects?.bots);render('reconnectServerCharts',dashboard.reconnects?.servers)}
    function renderBotDetails(){const bots=dashboard.overview?.bots||[];document.getElementById('dashboardBotDetails').innerHTML=bots.map(bot=>`<article class="bot-detail"><div class="card-head"><div><h2>${esc(bot.displayName)}</h2><p>${esc(bot.botId)} · ${esc(bot.instanceId||'no runtime instance')}</p></div><span class="pill ${bot.online?'online':''}">${esc(bot.status)}</span></div><div class="detail-grid"><span>Health <strong>${esc(bot.health??'-')}</strong></span><span>Food <strong>${esc(bot.food??'-')}</strong></span><span>World <strong>${esc(bot.worldId||'-')}</strong></span><span>Position <strong>${bot.position?`${esc(bot.position.x)}, ${esc(bot.position.y)}, ${esc(bot.position.z)}`:'-'}</strong></span><span>Task <strong>${esc(bot.currentTask?.detail || bot.currentTask || '-')}</strong></span><span>Skill <strong>${esc(bot.activeSkill||'-')}</strong></span><span>Step <strong>${esc(bot.currentStep||'-')}</strong></span><span>Retry <strong>${esc(`${bot.retry?.attempt||0}/${bot.retry?.max||0}`)}</strong></span><span>Path <strong>${esc(bot.pathfinder?.status||'-')}</strong></span><span>Heartbeat <strong>${bot.heartbeatAgeMs==null?'-':`${Math.round(bot.heartbeatAgeMs/1000)}s`}</strong></span></div><details><summary>Inventory & capabilities</summary><p>${Object.entries(bot.inventorySummary||{}).map(([name,count])=>`${esc(name)}: ${count}`).join(', ')||'Empty or unknown'}</p><p>${(bot.capabilities||[]).map(esc).join(', ')||'No capabilities reported'}</p></details>${bot.debug?`<details><summary>Debug details</summary><pre>${esc(JSON.stringify(bot.debug,null,2))}</pre></details>`:''}<div class="inline bot-controls" data-bot-id="${esc(bot.botId)}"><button data-control="pause" class="secondary">Pause task</button><button data-control="resume">Resume</button><button data-control="cancel-task" class="secondary">Cancel task</button><button data-control="return-home" class="secondary">Return home</button><button data-control="idle" class="secondary">Idle</button><button data-control="reconnect" class="danger">Reconnect</button><button data-control="emergency-stop" class="danger">Emergency stop</button></div>${bot.lastError?`<div class="notice warning">${esc(bot.lastError)}</div>`:''}</article>`).join('')||'<div class="empty">No dashboard bot data.</div>'}
    function filteredTasks(){const value=id=>document.getElementById(id).value.toLowerCase(),status=value('taskStatusFilter'),skill=value('taskSkillFilter'),bot=value('taskBotFilter'),goal=value('taskGoalFilter'),world=value('taskWorldFilter'),error=value('taskErrorFilter'),priority=value('taskPriorityFilter'),sort=value('taskSort');return (state.team?.tasks||[]).filter(t=>(!status||t.status===status)&&(!skill||String(t.skill).toLowerCase().includes(skill))&&(!bot||String(t.assignedBotId||'').toLowerCase().includes(bot))&&(!goal||String(t.teamGoalId||'').toLowerCase().includes(goal))&&(!world||String(t.worldId||'').toLowerCase().includes(world))&&(!error||String(t.lastError||'').toLowerCase().includes(error))&&(!priority||Number(t.priority)===Number(priority))).sort((a,b)=>sort==='newest'?Number(b.createdAt)-Number(a.createdAt):sort==='oldest'?Number(a.createdAt)-Number(b.createdAt):Number(b.priority)-Number(a.priority))}
    function renderTaskBoard(){const groups=['available','reserved','assigned','running','blocked','completed','failed','cancelled'],tasks=filteredTasks();document.getElementById('dashboardTaskBoard').innerHTML=groups.map(status=>`<div class="task-column"><h2>${esc(status)} <span class="pill">${tasks.filter(t=>t.status===status).length}</span></h2>${tasks.filter(t=>t.status===status).map(t=>{const reservations=(state.team?.reservations||[]).filter(r=>r.taskId===t.id).length,duration=t.startedAt?Math.round(((t.completedAt||t.failedAt||Date.now())-t.startedAt)/1000):null;return `<article class="task-card"><strong>${esc(t.skill)}</strong><small>${esc(t.id)}</small><p>Goal: ${esc(t.teamGoalId||'-')}<br>Owner: ${esc(t.assignedBotId||'unassigned')}<br>Priority: ${esc(t.priority)} · Retry: ${esc(t.retryCount||0)}/${esc(t.maxRetries||0)}<br>Dependencies: ${(t.dependencies||[]).length} · Reservations: ${reservations}<br>Duration: ${duration==null?'-':`${duration}s`} · Lease: ${t.reservationExpiresAt?new Date(t.reservationExpiresAt).toLocaleTimeString():'-'}</p>${t.progress?`<small>Progress: ${esc(t.progress.skill||'active')} ${t.progress.position?`at ${esc(t.progress.position.x)}, ${esc(t.progress.position.z)}`:''}</small>`:''}${t.lastError?`<span class="value-bad">${esc(t.lastError)}</span>`:''}</article>`}).join('')||'<div class="empty">Empty</div>'}</div>`).join('')}
    function renderLearning(){const skills=dashboard.skills||[];document.getElementById('skillSummary').innerHTML=[metric('Measured skills',skills.length),metric('Executions',skills.reduce((n,s)=>n+s.executions,0)),metric('Failures',skills.reduce((n,s)=>n+s.failures,0))].join('');document.getElementById('skillCharts').innerHTML=skills.filter(s=>s.executions>0).slice(0,12).map(s=>`<div class="skill-bar"><span>${esc(s.name)}</span><div class="meter"><span style="width:${Math.round(Number(s.successRate||0)*100)}%"></span></div><small>${Math.round(Number(s.successRate||0)*100)}% · ${s.executions} uses · ${s.failures} errors</small></div>`).join('')||'<div class="empty">Nog onvoldoende gegevens voor grafieken</div>';document.getElementById('skillTable').innerHTML=skills.length?`<table><thead><tr><th>Skill</th><th>Version</th><th>Executions</th><th>Success</th><th>Average</th><th>Trend</th><th>Best bot</th><th>Errors</th></tr></thead><tbody>${skills.map(s=>`<tr><td>${esc(s.name)}</td><td>${esc(s.version||'-')}</td><td>${s.executions}</td><td>${s.successRate==null?'Insufficient data':`${Math.round(s.successRate*100)}%`}</td><td>${s.averageDurationMs==null?'-':`${Math.round(s.averageDurationMs/1000)}s`}</td><td>${esc(s.recentTrend)}</td><td>${esc(s.bestBotId?botName(s.bestBotId):'-')}</td><td>${(s.commonErrors||[]).map(e=>`${esc(e.errorCode)} (${e.count})`).join(', ')||'-'}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">Nog onvoldoende gegevens</div>';document.getElementById('experienceList').innerHTML=(dashboard.experiences||[]).map(e=>`<div class="item"><strong>${esc(e.skill||e.task)}</strong><span class="pill">${e.success?'SUCCESS':esc(e.errorCode||'FAILED')}</span><small>${e.botId?`${esc(botName(e.botId))} · `:''}${esc(e.lesson||'No recorded lesson')} · ${esc(e.createdAt||'')}</small></div>`).join('')||'<div class="empty">Nog onvoldoende gegevens</div>'}
    function renderLogistics(){const data=dashboard.logistics||{},stale=(data.containers||[]).filter(c=>!c.lastVerifiedAt||Date.now()-Number(c.lastVerifiedAt)>300000);document.getElementById('logisticsWarnings').innerHTML=stale.length?`<div class="notice warning">${stale.length} container inventories are stale or unknown.</div>`:'';document.getElementById('botInventories').innerHTML=(data.botInventories||[]).map(b=>`<div class="item bot-inventory-row"><strong class="bot-display-name">${esc(botName(b.botId))}</strong><small class="bot-inventory-items">${Object.entries(b.inventorySummary||{}).map(([n,c])=>`${esc(n)}: ${c}`).join(', ')||'Unknown'}</small></div>`).join('')||'<div class="empty">No inventory telemetry.</div>';document.getElementById('containerInventory').innerHTML=(data.containers||[]).map(c=>`<div class="item"><strong>${esc(c.id)}</strong><small>Verified ${esc(c.lastVerifiedAt||'unknown')}</small>${(c.items||[]).map(i=>`<p>${esc(i.item)} · Present ${i.present} · Reserved ${i.reserved} · Available ${i.available}</p>`).join('')}</div>`).join('')||'<div class="empty">No verified containers.</div>';document.getElementById('inventoryReservations').innerHTML=(data.reservations||[]).map(r=>`<div class="item"><strong>${esc(r.item)} × ${r.amount}</strong><small>${esc(botName(r.botId))} · ${esc(r.taskId)}</small></div>`).join('')||'<div class="empty">No inventory reservations.</div>'}
    function schematicErrorMessage(code){return({LOW_HEALTH:'De bot had te weinig gezondheid om veilig te bouwen. Laat de bot eerst herstellen en probeer daarna opnieuw.',NO_FOOD:'De bot heeft eerst voedsel nodig.',UNSAFE_ENVIRONMENT:'De omgeving of toestand van de bot was niet veilig genoeg.',INSUFFICIENT_ITEMS:'De bot mist één of meer bouwmaterialen.',PATH_FAILED:'De bot kon de bouwlocatie niet veilig bereiken.',VALIDATION_FAILED:'Niet alle doelblokken konden in de wereld worden bevestigd.',CANCELLED:'De opdracht is geannuleerd.',TIMEOUT:'De bouwopdracht duurde langer dan toegestaan.'})[code]||'Bekijk Events & Logs voor de technische foutdetails.'}
    function renderSchematics(){const items=dashboard.schematics||[],selected=document.getElementById('schematicSelect').value;document.getElementById('schematicSelect').innerHTML=items.map(item=>`<option value="${esc(item.id)}">${esc(item.name)} (${item.width}×${item.height}×${item.length})</option>`).join('')||'<option value="">No schematics uploaded</option>';if(items.some(item=>item.id===selected))document.getElementById('schematicSelect').value=selected;document.getElementById('schematicList').innerHTML=items.map(item=>`<div class="item schematic-library-row"><div><strong>${esc(item.name)}</strong><small>${item.width}×${item.height}×${item.length} · ${item.blockCount} blocks</small></div><button type="button" class="danger" data-delete-schematic="${esc(item.id)}">Delete</button></div>`).join('')||'<div class="empty">No schematics uploaded.</div>';const bots=(state.team?.bots||[]).filter(bot=>bot.online&&bot.capabilities?.includes('buildSchematic')),primary=document.getElementById('schematicPrimaryBot').value;document.getElementById('schematicPrimaryBot').innerHTML=bots.map(bot=>`<option value="${esc(bot.botId)}">${esc(botName(bot.botId))} · ${bot.safetyState==='unsafe'?'UNSAFE · ':''}${esc(worldName(bot.worldId))}</option>`).join('')||'<option value="">No capable online bots</option>';if(bots.some(bot=>bot.botId===primary))document.getElementById('schematicPrimaryBot').value=primary;document.getElementById('schematicBuilds').innerHTML=(dashboard.schematicBuilds||[]).map(job=>`<article class="schematic-build-card"><div class="schematic-build-head"><strong>${esc(job.schematicName)}</strong><div class="schematic-build-actions"><span class="pill ${job.status==='completed'?'online':''}">${esc(String(job.status||'unknown').toUpperCase())}</span>${['completed','failed','cancelled'].includes(job.status)?`<button type="button" class="schematic-remove-button" data-remove-build="${esc(job.id)}" title="Verwijder deze build uit de historie" aria-label="Verwijder build ${esc(job.schematicName)}">×</button>`:''}</div></div><small class="schematic-build-meta">Locatie ${esc(job.origin?.x)}, ${esc(job.origin?.y)}, ${esc(job.origin?.z)} · verzonden ${new Date(job.createdAt).toLocaleTimeString()}</small>${(job.builders||[]).map(builder=>`<div class="schematic-builder-result"><strong>${esc(botName(builder.botId))}</strong><span>${esc(builder.status)} · ${builder.blocks} blokken</span>${builder.errorCode?`<strong class="value-bad">${esc(builder.errorCode)}</strong><span></span><small class="schematic-error-help">${esc(schematicErrorMessage(builder.errorCode))}${builder.result?.data?.missingMaterials?.length?` Ontbrekend: ${builder.result.data.missingMaterials.map(esc).join(', ')}.`:''}${builder.result?.data?.problems?.length?` Details: ${builder.result.data.problems.slice(0,3).map(problem=>esc(problem.reason||problem)).join(', ')}.`:''}</small><button type="button" class="secondary schematic-retry-button" data-retry-build="${esc(job.id)}" data-retry-bot="${esc(builder.botId)}">Retry</button>`:''}</div>`).join('')}</article>`).join('')||'<div class="empty">No build assignments yet.</div>';renderSchematicDetails();renderSchematicHelpers()}
    function renderSchematicDetails(){const item=(dashboard.schematics||[]).find(value=>value.id===document.getElementById('schematicSelect').value),target=document.getElementById('schematicDetails');if(!item){target.className='empty';target.textContent='Select a schematic.';return}target.className='';target.innerHTML=`<strong>${esc(item.name)}</strong><p>Size: ${item.width} × ${item.height} × ${item.length}<br>Blocks: ${item.blockCount}</p><p>${Object.entries(item.materials||{}).sort((a,b)=>b[1]-a[1]).map(([name,count])=>`${esc(name)}: ${count}`).join('<br>')}</p>`}
    function renderSchematicHelpers(){const primary=(state.team?.bots||[]).find(bot=>bot.botId===document.getElementById('schematicPrimaryBot').value),origin={x:Number(document.getElementById('schematicX').value),y:Number(document.getElementById('schematicY').value),z:Number(document.getElementById('schematicZ').value)},target=document.getElementById('schematicHelpers'),previous=new Set([...target.querySelectorAll('input:checked')].map(input=>input.value));if(!primary||!Object.values(origin).every(Number.isFinite)){target.innerHTML='<div class="empty">Choose a primary bot and build coordinates first.</div>';return}const nearby=(state.team?.bots||[]).filter(bot=>bot.online&&bot.botId!==primary.botId&&bot.worldId===primary.worldId&&bot.position&&bot.capabilities?.includes('buildSchematic')).map(bot=>({...bot,distance:Math.hypot(bot.position.x-origin.x,bot.position.y-origin.y,bot.position.z-origin.z)})).filter(bot=>bot.distance<=64).sort((a,b)=>a.distance-b.distance);target.innerHTML=nearby.map(bot=>`<label class="target-bot"><input type="checkbox" value="${esc(bot.botId)}" ${previous.has(bot.botId)?'checked':''}><span>Mag ${esc(botName(bot.botId))} meehelpen?</span><small>${bot.distance.toFixed(1)} blocks away</small></label>`).join('')||'<div class="empty">No nearby capable bots within 64 blocks.</div>'}
    function renderEvents(){const value=id=>document.getElementById(id).value.toLowerCase(),level=value('eventLevelFilter'),bot=value('eventBotFilter'),goal=value('eventGoalFilter'),task=value('eventTaskFilter'),error=value('eventErrorFilter'),period=Number(value('eventTimeFilter')||0);const events=(dashboard.events||[]).filter(e=>(!level||e.level===level)&&(!bot||String(e.botId||'').toLowerCase().includes(bot))&&(!goal||String(e.goalId||'').toLowerCase().includes(goal))&&(!task||String(e.taskId||'').toLowerCase().includes(task))&&(!error||String(e.errorCode||'').toLowerCase().includes(error))&&(!period||Date.now()-Number(e.timestamp)<=period));document.getElementById('dashboardEventFeed').innerHTML=events.map(e=>`<div class="event event-${esc(e.level)}"><time>${esc(new Date(e.timestamp).toLocaleTimeString())}</time><span>${esc(e.level)}</span><strong>${esc(e.message)}</strong><small>${esc(e.errorCode||e.taskId||'')}</small></div>`).join('')||'<div class="empty">No matching events.</div>'}
    function renderDashboardSettings(){const d=state.dashboard||{};document.getElementById('dashboardAppVersion').textContent=state.appVersion||'0.0.0';document.getElementById('dashboardEnabled').value=String(d.enabled!==false);document.getElementById('dashboardRealtime').value=String(d.realtimeEnabled!==false);document.getElementById('dashboardDebug').value=String(d.debugMode===true);document.getElementById('dashboardControls').value=String(d.allowControlActions!==false);const discordState=document.getElementById('discordTokenState'),updateState=document.getElementById('systemUpdateState'),update=settingsIntegrations?.update,tokenStatus=document.getElementById('dashboardTokenStatus');discordState.textContent=settingsIntegrations?.discord?.tokenConfigured?`Discord token configured · bridge ${settingsIntegrations.discord.running?'online':'offline'}`:'No Discord bot token configured.';discordState.classList.toggle('warning',!settingsIntegrations?.discord?.tokenConfigured);updateState.textContent=update?.message||`Installed version ${state.appVersion||'unknown'} · no update running.`;updateState.classList.toggle('warning',update?.status==='failed');document.getElementById('systemUpdateButton').disabled=Boolean(update?.running);tokenStatus.textContent=currentDashboardToken()?'Token is actief voor dit browsertabblad.':'Geen token actief; bekijken werkt, externe besturing niet.'}

    async function sendHubInput(text, botIds = []) {
      const result = await api('/api/command', {
        method:'POST',
        body:JSON.stringify({ text, botIds })
      })
      const skipped = result.skipped.length ? ` Skipped offline: ${result.skipped.join(', ')}.` : ''
      const targetNames = botIds.length
        ? state.bots.filter(bot => botIds.includes(bot.id)).map(bot => bot.name).join(', ') || 'selected bots'
        : 'All bots'
      hubChatLines.push({ at:new Date().toISOString(), botName:'Hub', role:'sent', author:targetNames, message:text })
      hubChatLines.splice(0, Math.max(0, hubChatLines.length - 80))
      renderChat()
      return `Sent to ${result.sent.length} bot${result.sent.length === 1 ? '' : 's'}.${skipped}`
    }

    function renderMerge() {
      const selected = new Set([...document.querySelectorAll('#mergeList input:checked')].map(input => input.value))
      document.getElementById('mergeList').innerHTML = state.bots.length
        ? state.bots.map(bot => `<label class="merge-row">
            <input type="checkbox" value="${esc(bot.id)}" ${selected.has(bot.id) ? 'checked' : ''} ${bot.status?.running ? 'disabled' : ''}>
            <span><strong>${esc(bot.name)}</strong><p>${esc(bot.folder)}\\knowledge</p></span>
            <span class="pill ${bot.status?.running ? 'external' : ''}">${bot.status?.running ? 'Running' : 'Ready'}</span>
          </label>`).join('')
        : '<div class="empty">Add bot folders before merging knowledge.</div>'
      updateMergeSelection()
      renderMergedKnowledge()
    }

    function botOptions(includeEmpty = true) {
      return `${includeEmpty ? '<option value="">Choose bot</option>' : ''}${state.bots.map(bot => `<option value="${esc(bot.id)}">${esc(bot.name)}</option>`).join('')}`
    }

    function renderManage() {
      const selectedTargets = new Set([...document.querySelectorAll('#updateTargets input:checked')].map(input => input.value))
      const previousLogBot = document.getElementById('logBot').value
      const previousSource = document.getElementById('updateSource').value
      const previousClone = document.getElementById('cloneSource').value
      const previousRestore = document.getElementById('restoreBot').value
      const previousKnowledgeSource = document.getElementById('knowledgeSource').value
      const previousKnowledgeTarget = document.getElementById('knowledgeTarget').value
      const groups = state.groups || []
      document.getElementById('groupList').innerHTML = groups.map(group => `<div class="item"><strong>${esc(group)}</strong><span class="inline"><button class="secondary" data-group-action="start" data-group="${esc(group)}">Start</button><button class="secondary" data-group-action="stop" data-group="${esc(group)}">Stop</button>${group === 'Ungrouped' ? '' : `<button class="danger" data-group-delete="${esc(group)}">Delete</button>`}</span></div>`).join('') || '<p>No groups yet.</p>'
      document.getElementById('profileList').innerHTML = (state.serverProfiles || []).map(profile => `<div class="item"><strong>${esc(profile.name)}</strong><span>${esc(profile.host)}:${esc(profile.port)} | ${esc(profile.version || '1.21.4')} <button class="secondary" data-apply-profile="${esc(profile.id)}">Apply to selected update targets</button></span></div>`).join('') || '<p>No server profiles yet.</p>'
      document.getElementById('profileVersion').innerHTML = minecraftVersionOptions('1.21.4')
      document.getElementById('bulkVersion').innerHTML = minecraftVersionOptions('1.21.4')
      document.getElementById('scheduleGroup').innerHTML = groups.map(group => `<option>${esc(group)}</option>`).join('')
      document.getElementById('scheduleList').innerHTML = (state.schedules || []).map(schedule => `<div class="item"><strong>${esc(schedule.time)} ${esc(schedule.action)}</strong><span>${esc(schedule.group)}</span></div>`).join('') || '<p>No schedules yet.</p>'
      document.getElementById('updateSource').innerHTML = botOptions()
      document.getElementById('cloneSource').innerHTML = botOptions()
      document.getElementById('updateTargets').innerHTML = state.bots.map(bot => {
        const isSource = bot.id === previousSource
        return `<label class="target-bot"><input type="checkbox" value="${esc(bot.id)}" ${selectedTargets.has(bot.id) && !isSource ? 'checked' : ''} ${bot.status?.running || isSource ? 'disabled' : ''}><span>${esc(bot.name)}${isSource ? ' (source)' : ''}</span><span class="pill">${isSource ? 'Source' : (bot.status?.running ? 'Running' : 'Ready')}</span></label>`
      }).join('')
      document.getElementById('historyList').innerHTML = (state.mergeHistory || []).slice(0, 12).map(entry => `<div class="item"><strong>${esc(entry.action)}</strong><span>${esc(entry.mergeId || entry.backup || '')}<br>${esc((entry.bots || []).join(', '))}</span></div>`).join('') || '<p>No merge history yet.</p>'
      document.getElementById('restoreBot').innerHTML = botOptions()
      document.getElementById('knowledgeSource').innerHTML = botOptions()
      document.getElementById('knowledgeTarget').innerHTML = botOptions()
      document.getElementById('logBot').innerHTML = botOptions()
      document.getElementById('logBot').value = previousLogBot
      document.getElementById('updateSource').value = previousSource
      document.getElementById('cloneSource').value = previousClone
      document.getElementById('restoreBot').value = previousRestore
      document.getElementById('knowledgeSource').value = previousKnowledgeSource
      document.getElementById('knowledgeTarget').value = previousKnowledgeTarget
    }

    function renderChatTargets() {
      const target = document.getElementById('chatTargets')
      const previous = new Set([...target.querySelectorAll('input:checked')].map(input => input.value))
      const selected = previous.size ? previous : new Set(['all'])
      const groupBoxes = (state.groups || []).map(group => `<label><input type="checkbox" value="group:${esc(group)}" ${selected.has(`group:${group}`) ? 'checked' : ''}>Group: ${esc(group)}</label>`).join('')
      const botBoxes = state.bots.map(bot => `<label><input type="checkbox" value="bot:${esc(bot.id)}" ${selected.has(`bot:${bot.id}`) ? 'checked' : ''}>${esc(bot.name)}</label>`).join('')
      target.innerHTML = `<label><input type="checkbox" value="all" ${selected.has('all') ? 'checked' : ''}>All bots</label>${groupBoxes}${botBoxes}`
    }

    function selectedChatBotIds() {
      const selected = [...document.querySelectorAll('#chatTargets input:checked')].map(input => input.value)
      if (!selected.length || selected.includes('all')) return []
      const ids = new Set()
      for (const value of selected) {
        if (value.startsWith('bot:')) ids.add(value.slice(4))
        if (value.startsWith('group:')) {
          const group = value.slice(6)
          for (const bot of state.bots.filter(item => item.group === group)) ids.add(bot.id)
        }
      }
      return [...ids]
    }

    function renderChat() {
      renderChatTargets()
      const seen = new Set()
      const lines = []
      const addLine = line => {
        const key = [line.botName, line.at, line.role, line.author, line.message].map(value => String(value ?? '')).join('\u0001')
        if (seen.has(key)) return
        seen.add(key)
        lines.push(line)
      }
      for (const line of hubChatLines) addLine(line)
      for (const bot of state.bots) {
        for (const entry of bot.telemetry?.chatHistory || []) {
          addLine({ ...entry, botName:bot.name, sortAt:Date.parse(entry.at || '') || 0 })
        }
      }
      if (!lines.length) {
        for (const bot of state.bots) {
          addLine({
            at:new Date().toISOString(),
            botName:bot.name,
            role:bot.status?.hudOnline ? 'waiting' : 'offline',
            author:'Hub',
            message:bot.status?.hudOnline ? 'Waiting for chat from this bot.' : 'Bot is offline. Start it to receive chat.',
            sortAt:0
          })
        }
      }
      const chatSortTime = line => Number.isFinite(line.sortAt) ? line.sortAt : (Date.parse(line.at || '') || 0)
      lines.sort((left, right) => chatSortTime(left) - chatSortTime(right))
      const consoleEl = document.getElementById('chatConsole')
      const nearBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 80
      const visible = lines.slice(-220)
      consoleEl.innerHTML = visible.length ? visible.map(line => `
        <div class="chat-line">
          <span class="time">${esc(line.at ? amsterdamTime(line.at) : '--:--:--')}</span>
          <span class="bot">${esc(line.botName)}</span>
          <span class="role">${esc(line.role || 'chat')}</span>
          <span class="message">${esc(line.author ? `${line.author}: ${line.message || ''}` : line.message || '')}</span>
        </div>`).join('') : '<div class="empty">No bots yet. Add or start a bot to see chat here.</div>'
      if (nearBottom) consoleEl.scrollTop = consoleEl.scrollHeight
    }

    function bytes(value) {
      const size = Number(value || 0)
      if (!size) return '-'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let index = 0
      let next = size
      while (next >= 1024 && index < units.length - 1) {
        next /= 1024
        index++
      }
      return `${next.toFixed(index ? 1 : 0)} ${units[index]}`
    }

    function renderHealth() {
      const grid = document.getElementById('healthGrid')
      if (!health) {
        grid.innerHTML = '<div class="empty">Press Refresh health to run system checks.</div>'
        return
      }
      document.getElementById('healthChecked').textContent = `Checked ${amsterdamTime(health.checkedAt)}`
      const pathItems = health.paths.map(item => `<li><strong>${esc(item.name)}</strong><span class="${item.ok ? 'value-good' : 'value-bad'}">${item.ok ? 'OK' : 'Missing'}</span></li>`).join('')
      const portMap = new Map((health.ports || []).map(item => [Number(item.port), item.listening ? 'Listening' : 'Free']))
      const portStatus = port => portMap.get(Number(port)) || 'Free'
      const portClass = port => portStatus(port) === 'Listening' ? 'value-good' : ''
      const portItems = [
        `<li><strong>${esc(state.hubPort || 3100)}</strong><span class="${portClass(state.hubPort || 3100)}">${esc(portStatus(state.hubPort || 3100))}</span></li>`,
        ...state.bots.map(bot => `
          <li>
            <strong>${esc(bot.hudPort)} | ${esc(bot.viewerPort)}</strong>
            <span class="port-status-pair">
              <span class="${portClass(bot.hudPort)}">${esc(portStatus(bot.hudPort))}</span>
              <span class="${portClass(bot.viewerPort)}">${esc(portStatus(bot.viewerPort))}</span>
            </span>
          </li>`)
      ].join('')
      const diskUsed = health.disk?.size ? Math.round(((health.disk.size - health.disk.free) / health.disk.size) * 100) : 0
      const botItems = health.bots.map(bot => `<li><strong>${esc(bot.name)}</strong><span class="${bot.stats?.lastError ? 'value-bad' : 'value-good'}">${esc(bot.stats?.lastError || 'OK')}</span></li>`).join('')
      const discordStatus = health.discord || {}
      const discordOnline = discordStatus.running
      const configBackups = (health.configBackups || []).slice(0, 5).map(backup => `<li><strong>${esc(backup.name)}</strong><span>${esc(bytes(backup.size))}</span></li>`).join('')
      grid.innerHTML = `
        <div class="health-block"><h2>Required files</h2><ul>${pathItems}</ul></div>
        <div class="health-block"><h2>Ports</h2><ul class="compact-ports">${portItems}</ul></div>
        <div class="health-block"><h2>Backups and logs</h2><ul>
          <li><strong>Latest backup</strong><span>${esc(health.latestBackup?.name || 'None')}</span></li>
          <li><strong>Startup backups</strong><span>${esc(health.startupBackupCount)}</span></li>
          <li><strong>Config backups</strong><span>${esc((health.configBackups || []).length)}</span></li>
          <li><strong>Hub log files</strong><span>${esc(health.hubLogCount)}</span></li>
          ${configBackups}
        </ul></div>
        <div class="health-block"><h2>Discord bridge</h2><ul>
          <li><strong>Status</strong><span class="${discordOnline ? 'value-good' : 'value-bad'}">${discordOnline ? 'Online' : 'Offline'}</span></li>
          <li><strong>Bot channels</strong><span>${esc(discordStatus.botChannelCount || 0)}</span></li>
          <li><strong>Server chat channels</strong><span>${esc(discordStatus.serverChatChannelCount || 0)}</span></li>
          <li><strong>Last error</strong><span class="${discordStatus.lastError ? 'value-bad' : 'value-good'}">${esc(discordStatus.lastError || 'OK')}</span></li>
        </ul></div>
        <div class="health-block"><h2>USB drive</h2>
          <p>${esc(health.disk?.drive || 'Drive')} free: ${esc(bytes(health.disk?.free))} / ${esc(bytes(health.disk?.size))}</p>
          <div class="meter"><span style="width:${Math.min(100, Math.max(0, diskUsed))}%"></span></div>
        </div>
        <div class="health-block"><h2>Bot errors</h2><ul>${botItems || '<li><strong>No bots</strong><span>-</span></li>'}</ul></div>`
    }

    function renderDiscord() {
      const grid = document.getElementById('discordGrid')
      if (!discord) {
        grid.innerHTML = '<div class="empty">Press Refresh Discord to check the bridge.</div>'
        return
      }
      document.getElementById('discordChecked').textContent = `Checked ${amsterdamTime()}`
      renderTopStatus()
      const botChannels = (discord.botChannels || []).map(item => `<li><strong>${esc(item.botName)}</strong><span>${esc(item.channelId)}</span></li>`).join('')
      const serverChannels = (discord.serverChatChannels || []).map(item => `<li><strong>${esc(item.botName)}</strong><span>${esc(item.channelId)}</span></li>`).join('')
      const outLines = (discord.lastOutput || []).join('\n')
      const errLines = (discord.errorLines || []).join('\n')
      grid.innerHTML = `
        <div class="health-block"><h2>Bridge status</h2><ul>
          <li><strong>Installed</strong><span class="${discord.installed ? 'value-good' : 'value-bad'}">${discord.installed ? 'OK' : 'Missing'}</span></li>
          <li><strong>Status</strong><span class="${discord.running ? 'value-good' : 'value-bad'}">${discord.running ? 'Online' : 'Offline'}</span></li>
          <li><strong>PID</strong><span>${esc(discord.pid || '-')}</span></li>
          <li><strong>Prefix</strong><span>${esc(discord.prefix || '!mc')}</span></li>
          <li><strong>Hub URL</strong><span>${esc(discord.hubUrl || '-')}</span></li>
          <li><strong>Last error</strong><span class="${discord.lastError ? 'value-bad' : 'value-good'}">${esc(discord.lastError || 'OK')}</span></li>
        </ul></div>
        <div class="health-block"><h2>Linked bot channels</h2><ul>${botChannels || '<li><strong>No bot channels</strong><span>Use !mc link &lt;bot&gt;</span></li>'}</ul></div>
        <div class="health-block"><h2>Linked server chat</h2><ul>${serverChannels || '<li><strong>No server chat channels</strong><span>Use !mc server chat link &lt;bot&gt;</span></li>'}</ul></div>
        <div class="health-block"><h2>Bridge output</h2><div class="log-snippet">${esc(outLines || 'No output yet.')}</div></div>
        <div class="health-block"><h2>Bridge errors</h2><div class="log-snippet">${esc(errLines || 'No errors.')}</div></div>`
    }

    async function refreshDiscord() {
      try {
        const result = await api('/api/discord/status')
        discord = result.discord
        renderDiscord()
      } catch (err) {
        notify(err.message, true)
      }
    }

    function orderedViewerBots() {
      const order = state.viewerLayout?.order || []
      return [...state.bots].sort((a, b) => {
        const ai = order.indexOf(a.id)
        const bi = order.indexOf(b.id)
        return (ai < 0 ? 9999 : ai) - (bi < 0 ? 9999 : bi)
      })
    }

    function renderViewers(force = false) {
      const hidden = new Set(state.viewerLayout?.hidden || [])
      const bots = orderedViewerBots()
      const columns = state.viewerLayout?.columns || 2
      const key = JSON.stringify({ columns, hidden:[...hidden], bots:bots.map(bot => [bot.id, bot.status?.viewerOnline, bot.telemetry?.username]) })
      document.getElementById('viewerColumns').value = String(columns)
      document.getElementById('viewerGrid').style.setProperty('--viewer-columns', columns)
      if (!force && key === viewerRenderKey) return
      viewerRenderKey = key
      const visible = bots.filter(bot => !hidden.has(bot.id))
      for (const bot of bots) {
        if (!bot.status?.viewerOnline) loadedViewers.delete(bot.id)
      }
      document.getElementById('viewerGrid').innerHTML = visible.length ? visible.map((bot, index) => `
        <article class="viewer-card" data-viewer-id="${esc(bot.id)}" draggable="true">
          <div class="camera-label"><span class="camera-number">${String(index + 1).padStart(2, '0')}</span><span>${esc(bot.name)}</span></div>
          <div class="viewer-actions">
            <button class="secondary" data-viewer-toggle="${bot.status?.viewerOnline ? 'off' : 'on'}">${bot.status?.viewerOnline ? 'Off' : 'On'}</button>
            <button class="secondary" data-viewer-hide>Hide</button>
          </div>
          <div class="camera-username">${esc(bot.telemetry?.username || 'Username not available')}</div>
          <div class="viewer-frame">${bot.status?.viewerOnline
            ? (loadedViewers.has(bot.id)
              ? `<iframe src="${esc(localServiceUrl(bot.viewerPort))}" title="${esc(bot.name)} viewer" loading="lazy"></iframe>`
              : `<div class="viewer-placeholder"><div><strong>${esc(bot.name)}</strong><span>Viewer is online but not loaded.</span><button type="button" data-viewer-load>Load viewer</button><br><a href="${esc(localServiceUrl(bot.viewerPort))}" target="_blank" rel="noopener">Open in own tab</a></div></div>`)
            : '<div class="viewer-offline">Not available</div>'}</div>
        </article>`).join('') : '<div class="empty">All camera fields are hidden.</div>'
      document.getElementById('hiddenCameras').innerHTML = bots.filter(bot => hidden.has(bot.id)).map(bot => `<button class="secondary" data-viewer-show="${esc(bot.id)}">Show ${esc(bot.name)}</button>`).join('')
    }

    async function saveViewerLayout(layout) {
      await api('/api/config', { method:'POST', body:JSON.stringify({ viewerLayout:layout }) })
      state.viewerLayout = layout
      viewerRenderKey = ''
      await refresh()
    }

    function renderMergedKnowledge() {
      const merges = state.mergedKnowledge || []
      document.getElementById('mergedCount').textContent = `${merges.length} merge${merges.length === 1 ? '' : 's'}`
      document.getElementById('mergedList').innerHTML = merges.length
        ? merges.map(merge => `<div class="merged-entry">
            <div class="merge-entry-head">
              <div><strong>${esc(merge.id)}</strong><p>${merge.fileCount} JSON files<br>${esc(merge.folder)}</p></div>
              <button type="button" class="secondary" data-open-merge="${esc(merge.folder)}">Open folder</button>
            </div>
            <div class="target-bots">
              ${state.bots.map(bot => {
                const selected = mergeTargets.get(merge.id)?.has(bot.id)
                return `<label class="target-bot">
                  <input type="checkbox" data-merge-target="${esc(merge.id)}" value="${esc(bot.id)}" ${selected ? 'checked' : ''} ${bot.status?.running ? 'disabled' : ''}>
                  <span><strong>${esc(bot.name)}</strong><small>${esc(bot.folder)}\\knowledge</small></span>
                  <span class="pill ${bot.status?.running ? 'external' : ''}">${bot.status?.running ? 'Running' : 'Ready'}</span>
                </label>`
              }).join('')}
            </div>
            <div class="apply-controls">
              <span class="pill" data-target-count="${esc(merge.id)}">${mergeTargets.get(merge.id)?.size || 0} selected</span>
              <button type="button" data-apply-merge="${esc(merge.id)}" ${(mergeTargets.get(merge.id)?.size || 0) ? '' : 'disabled'}>Apply to selected bots</button>
            </div>
          </div>`).join('')
        : '<div class="empty">No merged knowledge folders yet.</div>'
      for (const merge of merges) updateMergeTargets(merge.id)
    }

    function updateMergeTargets(mergeId) {
      const boxes = [...document.querySelectorAll(`[data-merge-target="${CSS.escape(mergeId)}"]`)]
      const selected = boxes.filter(box => box.checked).map(box => box.value)
      mergeTargets.set(mergeId, new Set(selected))
      for (const box of boxes) {
        const bot = state.bots.find(item => item.id === box.value)
        box.disabled = Boolean(bot?.status?.running)
      }
      const count = document.querySelector(`[data-target-count="${CSS.escape(mergeId)}"]`)
      const apply = document.querySelector(`[data-apply-merge="${CSS.escape(mergeId)}"]`)
      if (count) count.textContent = `${selected.length} selected`
      if (apply) apply.disabled = selected.length < 1
    }

    async function refresh() {
      if(refreshInFlight)return
      refreshInFlight=true
      try {
        state = await api('/api/state')
        const [schematicData,integrationData]=await Promise.all([api('/api/schematics'),api('/api/settings/integrations')]);dashboard.schematics=schematicData.schematics;dashboard.schematicBuilds=schematicData.builds||[];settingsIntegrations=integrationData
        if(state.dashboard?.enabled!==false)await refreshDashboardData()
        renderTopStatus()
        renderOverview()
        renderTeam()
        renderBots()
        renderMerge()
        renderManage()
        renderChat()
        renderViewers()
        renderDashboard()
        if (document.getElementById('health').classList.contains('active')) await refreshHealth()
        if (document.getElementById('discordHealth').classList.contains('active')) await refreshDiscord()
      } catch (err) {
        notify(err.message, true)
      } finally { refreshInFlight=false }
    }

    async function refreshDashboardData(forceDetails=false){const overview=await api('/api/dashboard/overview');dashboard.overview=overview.overview;for(const bot of dashboard.overview?.bots||[]){bot.worldId=bot.server?.host?`${bot.server.host}${bot.server.port?`:${bot.server.port}`:''}`:bot.worldId;if(bot.position)bot.position={...bot.position,x:coordinate(bot.position.x),y:coordinate(bot.position.y),z:coordinate(bot.position.z)}}if(forceDetails||Date.now()-lastDashboardDetailsAt>15000){const [skills,experiences,logistics,events,goals,reconnects]=await Promise.all([api('/api/learning/skills'),api('/api/learning/experiences?limit=50'),api('/api/logistics/inventory'),api('/api/events?limit=150'),api('/api/team/goals'),api('/api/dashboard/reconnects')]);dashboard.skills=skills.skills;dashboard.experiences=experiences.items;dashboard.logistics=logistics;dashboard.events=events.items;dashboard.goals=goals.dashboardGoals;dashboard.reconnects=reconnects;lastDashboardDetailsAt=Date.now()}}
    function connectDashboardStream(){dashboardStream?.close?.();const status=document.getElementById('dashboardConnection');if(state.dashboard?.enabled===false){status.textContent='Dashboard disabled in settings';return}if(state.dashboard?.realtimeEnabled===false){status.textContent='Realtime disabled; polling fallback active';return}dashboardStream=new EventSource('/api/dashboard/stream');dashboardStream.addEventListener('connected',()=>{status.textContent='Realtime dashboard connected';status.classList.remove('warning')});dashboardStream.addEventListener('dashboard',event=>{const value=JSON.parse(event.data);if(value.level!=='debug'){dashboard.events.unshift(value);dashboard.events=dashboard.events.slice(0,500);renderEvents()}clearTimeout(dashboardRefreshTimer);dashboardRefreshTimer=setTimeout(()=>refresh(),500)});dashboardStream.onerror=()=>{status.textContent='Realtime connection lost; reconnecting automatically…';status.classList.add('warning')}}

    async function refreshHealth() {
      try {
        const result = await api('/api/health')
        health = result.health
        discord = result.health.discord || discord
        renderTopStatus()
        renderHealth()
      } catch (err) {
        notify(err.message, true)
      }
    }

    function cardData(card) {
      const value = field => card.querySelector(`[data-field="${field}"]`).value.trim()
      return {
        name: value('name'),
        host: value('host'),
        port: Number(value('port')),
        version: value('version'),
        hudPort: Number(value('hudPort')),
        viewerPort: Number(value('viewerPort'))
        ,group: value('group')
        ,autoRestart: value('autoRestart') === 'true'
      }
    }

    async function saveCard(card) {
      await api(`/api/bots/${encodeURIComponent(card.dataset.id)}`, {
        method:'PATCH',
        body:JSON.stringify(cardData(card))
      })
    }

    function activateTab(tabName, updateHash = true) {
      const button = document.querySelector(`nav button[data-tab="${CSS.escape(tabName)}"]`)
      if (!button) return
      document.querySelectorAll('nav button').forEach(item => item.classList.toggle('active', item === button))
      document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.id === button.dataset.tab))
      document.getElementById('title').textContent = button.textContent
      if (updateHash) history.replaceState(null, '', `#${button.dataset.tab}`)
      if (button.dataset.tab === 'health' && !health) refreshHealth()
      if (button.dataset.tab === 'discordHealth' && !discord) refreshDiscord()
    }

    const hubThemeSelect = document.getElementById('siteTheme')
    function applyHubTheme(mode) {
      const theme = mode === 'light' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', theme)
      if (hubThemeSelect) hubThemeSelect.value = theme
      try { localStorage.setItem('bot-hub-theme', theme) } catch {}
      const themeColor = document.querySelector('meta[name="theme-color"]')
      if (themeColor) themeColor.content = theme === 'dark' ? '#070b12' : '#edf1e8'
    }
    let savedHubTheme = 'dark'
    try {
      const storedTheme = localStorage.getItem('bot-hub-theme')
      if (storedTheme === 'light' || storedTheme === 'dark') savedHubTheme = storedTheme
    } catch {}
    applyHubTheme(savedHubTheme)
    hubThemeSelect?.addEventListener('change', () => applyHubTheme(hubThemeSelect.value))

    document.querySelector('nav').addEventListener('click', event => {
      const button = event.target.closest('button[data-tab]')
      if (!button) return
      activateTab(button.dataset.tab)
    })

    document.getElementById('teamGoalForm').addEventListener('submit',async event=>{event.preventDefault();const status=document.getElementById('teamGoalStatus');try{const worldId=document.getElementById('teamWorld').value;if(!worldId)throw new Error('Start at least one team-enabled bot first.');const position={x:Number(document.getElementById('teamChestX').value),y:Number(document.getElementById('teamChestY').value),z:Number(document.getElementById('teamChestZ').value)};if(!Object.values(position).every(Number.isFinite))throw new Error('Enter the logistics chest coordinates.');const result=await api('/api/team/goals',{method:'POST',body:JSON.stringify({type:'obtain_iron_ingots',worldId,amount:Number(document.getElementById('teamIronAmount').value),target:{position},requestedBy:'hub-ui'})});status.textContent=`Created ${result.goal.id}`;await refresh()}catch(error){status.textContent=error.message}})
    document.getElementById('teamTasks').addEventListener('click',async event=>{const button=event.target.closest('[data-cancel-team-task]');if(!button||!confirm('Cancel this team task?'))return;await api(`/api/team/tasks/${encodeURIComponent(button.dataset.cancelTeamTask)}/cancel`,{method:'POST',body:JSON.stringify({confirmed:true})});await refresh()})
    document.getElementById('teamGoals').addEventListener('click',async event=>{const priorityButton=event.target.closest('[data-save-goal-priority]');if(priorityButton){const id=priorityButton.dataset.saveGoalPriority,priority=Number(document.querySelector(`[data-goal-priority="${CSS.escape(id)}"]`).value);await api(`/api/team/goals/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({priority})});return refresh()}const button=event.target.closest('[data-goal-action]');if(!button)return;const action=button.dataset.goalAction;if(action==='cancel'&&!confirm('Cancel this complete team goal and its unfinished tasks?'))return;await api(`/api/team/goals/${encodeURIComponent(button.dataset.goalId)}/${action}`,{method:'POST',body:JSON.stringify({confirmed:action==='cancel'})});await refresh()})
    document.getElementById('dashboardBotDetails').addEventListener('click',async event=>{const button=event.target.closest('[data-control]');if(!button)return;const action=button.dataset.control,botId=button.closest('[data-bot-id]').dataset.botId,destructive=['reconnect','emergency-stop'].includes(action);if(destructive&&!confirm(`Confirm ${action} for this bot?`))return;try{await api(`/api/team/bots/${encodeURIComponent(botId)}/${action}`,{method:'POST',body:JSON.stringify({confirmed:destructive})});notify(`${action} sent`)}catch(error){notify(error.message,true)}})
    for(const id of ['taskStatusFilter','taskSkillFilter','taskBotFilter','taskGoalFilter','taskWorldFilter','taskErrorFilter','taskPriorityFilter','taskSort'])document.getElementById(id).addEventListener('input',renderTaskBoard)
    for(const id of ['eventLevelFilter','eventBotFilter','eventGoalFilter','eventTaskFilter','eventErrorFilter','eventTimeFilter'])document.getElementById(id).addEventListener('input',renderEvents)
    document.getElementById('dashboardSettingsForm').addEventListener('submit',async event=>{event.preventDefault();await api('/api/config',{method:'POST',body:JSON.stringify({dashboard:{enabled:document.getElementById('dashboardEnabled').value==='true',realtimeEnabled:document.getElementById('dashboardRealtime').value==='true',debugMode:document.getElementById('dashboardDebug').value==='true',allowControlActions:document.getElementById('dashboardControls').value==='true'}})});await refresh();connectDashboardStream();notify('Dashboard settings saved')})
    document.getElementById('dashboardTokenForm').addEventListener('submit',async event=>{event.preventDefault();const input=document.getElementById('dashboardToken'),status=document.getElementById('dashboardTokenStatus'),token=input.value.trim();if(!token)return status.textContent='Vul eerst de DASHBOARD_TOKEN in.';try{sessionStorage.setItem('dashboardToken',token);await api('/api/dashboard/auth-check',{method:'POST',body:'{}'});input.value='';status.textContent='Telefoonbesturing is toegestaan zolang dit tabblad geopend blijft.';notify('Dashboard token accepted')}catch(error){sessionStorage.removeItem('dashboardToken');input.value='';status.textContent=`Token geweigerd: ${error.message}`}})
    document.getElementById('clearDashboardToken').addEventListener('click',()=>{try{sessionStorage.removeItem('dashboardToken')}catch{}document.getElementById('dashboardToken').value='';document.getElementById('dashboardTokenStatus').textContent='Token is uit dit tabblad verwijderd.'})
    document.getElementById('downloadDiagnostics').addEventListener('click',async()=>{const status=document.getElementById('diagnosticsStatus'),button=document.getElementById('downloadDiagnostics');button.disabled=true;status.textContent='Diagnostiekrapport wordt opgebouwd…';try{const response=await fetch('/api/diagnostics/download');if(!response.ok)throw new Error(`Download failed (${response.status})`);const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`f-mineflayer-diagnostics-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='Opgeschoond diagnostiekrapport gedownload.'}catch(error){status.textContent=error.message}finally{button.disabled=false}})
    document.getElementById('discordTokenForm').addEventListener('submit',async event=>{event.preventDefault();const input=document.getElementById('discordBotToken'),status=document.getElementById('discordTokenStatus');if(!input.value.trim())return status.textContent='Paste a Discord bot token first.';if(!confirm('Save this Discord bot token locally and restart the Discord bridge?'))return;try{status.textContent='Saving token and connecting…';await api('/api/settings/discord',{method:'POST',body:JSON.stringify({token:input.value.trim(),confirmed:true})});input.value='';status.textContent='Discord token saved; bridge is restarting.';await refresh()}catch(error){input.value='';status.textContent=error.message}})
    document.getElementById('removeDiscordToken').addEventListener('click',async()=>{const status=document.getElementById('discordTokenStatus');if(!confirm('Remove the locally stored Discord token and stop the bridge?'))return;try{await api('/api/settings/discord',{method:'POST',body:JSON.stringify({remove:true,confirmed:true})});document.getElementById('discordBotToken').value='';status.textContent='Discord link removed.';await refresh()}catch(error){status.textContent=error.message}})
    document.getElementById('systemUpdateButton').addEventListener('click',async()=>{
      const status=document.getElementById('systemUpdateStatus'),button=document.getElementById('systemUpdateButton')
      if(!confirm('Search for updates, create a backup, update the system and restart Hub and bots?'))return
      button.disabled=true
      try{
        await api('/api/system/update',{method:'POST',body:JSON.stringify({confirmed:true})})
        status.textContent='Naar updates zoeken... De Hub wordt alleen herstart als een nieuwere versie beschikbaar is.'
      }catch{
        // Info: een verbroken startverbinding is normaal wanneer de updater de Hub al aan het herstarten is.
        status.textContent='Updateproces gestart; wachten tot de Hub opnieuw verbonden is…'
      }
      const deadline=Date.now()+300000
      const poll=setInterval(async()=>{
        if(Date.now()>deadline){clearInterval(poll);button.disabled=false;status.textContent='Update is taking longer than expected. Check Logs/update.log.';return}
        try{
          const result=await api('/api/system/update/status')
          settingsIntegrations={...(settingsIntegrations||{}),update:result.update}
          renderDashboardSettings()
          if(['completed','failed'].includes(result.update.status)){
            clearInterval(poll);button.disabled=false;status.textContent=result.update.message
            if(result.update.status==='completed')setTimeout(()=>location.reload(),1500)
          }
        }catch{status.textContent='Hub is restarting; waiting for connection…'}
      },2000)
    })
    document.getElementById('updateAllBotCodeButton').addEventListener('click',async()=>{
      const button=document.getElementById('updateAllBotCodeButton'),status=document.getElementById('updateAllBotCodeStatus')
      if(!confirm('Update de code van ALLE andere bots vanuit official-bot? Actieve bots worden tijdelijk gestopt en daarna opnieuw gestart.'))return
      button.disabled=true;status.textContent='Botcode synchroniseren en actieve bots herstarten…'
      try{
        const result=await api('/api/update-all-bot-code',{method:'POST',body:JSON.stringify({confirmed:true})})
        const summary=`Bijgewerkt: ${result.updated.length}. Herstart: ${result.restarted.length}.`
        status.textContent=result.errors.length?`${summary} Fouten: ${result.errors.map(item=>`${item.bot} (${item.stage}: ${item.error})`).join('; ')}`:summary
        notify(result.errors.length?'Botcode gedeeltelijk bijgewerkt. Bekijk de melding in Settings.':'Alle botcode is bijgewerkt.',Boolean(result.errors.length))
        await refresh()
      }catch(error){status.textContent=error.message;notify(error.message,true)}finally{button.disabled=false}
    })
    document.getElementById('schematicUploadForm').addEventListener('submit',async event=>{event.preventDefault();const file=document.getElementById('schematicFile').files[0],status=document.getElementById('schematicUploadStatus');if(!file)return;try{status.textContent='Uploading and validating…';await api('/api/schematics/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Schematic-Name':encodeURIComponent(file.name)},body:await file.arrayBuffer()});document.getElementById('schematicFile').value='';status.textContent='Schematic saved.';await refresh()}catch(error){status.textContent=error.message}})
    document.getElementById('schematicList').addEventListener('click',async event=>{const button=event.target.closest('[data-delete-schematic]');if(!button||!confirm('Delete this stored schematic?'))return;await api(`/api/schematics/${encodeURIComponent(button.dataset.deleteSchematic)}`,{method:'DELETE',body:JSON.stringify({confirmed:true})});await refresh()})
    document.getElementById('schematicBuilds').addEventListener('click',async event=>{const button=event.target.closest('[data-retry-build]');if(!button)return;const job=(dashboard.schematicBuilds||[]).find(value=>value.id===button.dataset.retryBuild),builder=job?.builders?.find(value=>value.botId===button.dataset.retryBot),status=document.getElementById('schematicBuildStatus');if(!job||!builder)return notify('De oorspronkelijke buildopdracht is niet meer beschikbaar.',true);const name=botName(builder.botId);if(!confirm(`Schematic ${job.schematicName} opnieuw laten proberen door ${name} op ${job.origin.x}, ${job.origin.y}, ${job.origin.z}?`))return;button.disabled=true;status.textContent=`Retry voor ${name} wordt gestart…`;try{const result=await api(`/api/schematics/${encodeURIComponent(job.schematicId)}/build`,{method:'POST',body:JSON.stringify({primaryBotId:builder.botId,helperBotIds:[],origin:job.origin,rotation:Number(job.rotation||0)})});status.textContent=`Retry verzonden naar ${result.builders.map(bot=>bot.name).join(', ')}.`;await refresh()}catch(error){status.textContent=error.message;notify(error.message,true)}finally{button.disabled=false}})
    document.getElementById('schematicBuilds').addEventListener('click',async event=>{const button=event.target.closest('[data-remove-build]');if(!button)return;button.disabled=true;try{await api(`/api/schematics/builds/${encodeURIComponent(button.dataset.removeBuild)}`,{method:'DELETE',body:JSON.stringify({confirmed:true})});await refresh()}catch(error){notify(error.message,true);button.disabled=false}})
    document.getElementById('schematicSelect').addEventListener('change',renderSchematicDetails)
    document.getElementById('schematicPrimaryBot').addEventListener('change',renderSchematicHelpers)
    for(const id of ['schematicX','schematicY','schematicZ'])document.getElementById(id).addEventListener('input',renderSchematicHelpers)
    document.getElementById('usePrimaryPosition').addEventListener('click',()=>{const bot=(state.team?.bots||[]).find(value=>value.botId===document.getElementById('schematicPrimaryBot').value);if(!bot?.position)return notify('The primary bot has no live position.',true);document.getElementById('schematicX').value=Math.floor(bot.position.x);document.getElementById('schematicY').value=Math.floor(bot.position.y);document.getElementById('schematicZ').value=Math.floor(bot.position.z);renderSchematicHelpers()})
    document.getElementById('schematicBuildForm').addEventListener('submit',async event=>{event.preventDefault();const primaryBotId=document.getElementById('schematicPrimaryBot').value,helperBotIds=[...document.querySelectorAll('#schematicHelpers input:checked')].map(input=>input.value),origin={x:Number(document.getElementById('schematicX').value),y:Number(document.getElementById('schematicY').value),z:Number(document.getElementById('schematicZ').value)},schematicId=document.getElementById('schematicSelect').value,status=document.getElementById('schematicBuildStatus');if(!schematicId||!primaryBotId)return status.textContent='Choose a schematic and primary bot.';try{const result=await api(`/api/schematics/${encodeURIComponent(schematicId)}/build`,{method:'POST',body:JSON.stringify({primaryBotId,helperBotIds,origin,rotation:Number(document.getElementById('schematicRotation').value)})});status.textContent=`Build sent to ${result.builders.map(bot=>`${bot.name} (${bot.blocks} blocks)`).join(', ')}.`}catch(error){status.textContent=error.message}})

    document.getElementById('botAccessList').addEventListener('submit',async event=>{const form=event.target.closest('.bot-access-form');if(!form)return;event.preventDefault();const status=form.querySelector('.broadcast-status'),whitelistedPlayers=form.elements.whitelistedPlayers.value.split(/[\r\n,;]+/).map(value=>value.trim()).filter(Boolean);try{const result=await api(`/api/bots/${encodeURIComponent(form.dataset.botId)}/access`,{method:'PATCH',body:JSON.stringify({ownerPlayer:form.elements.ownerPlayer.value.trim(),whitelistedPlayers})});status.textContent=result.appliedLive?'Saved and applied live.':result.restartRequired?'Saved; restart this bot to apply.':'Saved.';await refresh()}catch(error){status.textContent=error.message}})

    window.addEventListener('hashchange', () => activateTab(location.hash.slice(1) || 'overview', false))

    document.getElementById('browseFolder').addEventListener('click', async () => {
      const button = document.getElementById('browseFolder')
      button.disabled = true
      try {
        notify('Waiting for folder selection...')
        const selection = await api('/api/folder-picker', { method:'POST', body:'{}' })
        if (!selection.folder) {
          notify('Folder selection cancelled')
          return
        }
        document.getElementById('folderPath').value = selection.folder
        notify('Folder selected')
      } catch (err) {
        notify(err.message, true)
      } finally {
        button.disabled = false
      }
    })

    document.getElementById('addFolder').addEventListener('click', async () => {
      const button = document.getElementById('addFolder')
      button.disabled = true
      try {
        const folder = document.getElementById('folderPath').value.trim()
        if (!folder) throw new Error('Choose a bot folder or enter its path first.')
        await api('/api/bots', { method:'POST', body:JSON.stringify({ folder }) })
        document.getElementById('folderPath').value = ''
        notify('Bot folder added')
        await refresh()
      } catch (err) {
        notify(err.message, true)
      } finally {
        button.disabled = false
      }
    })

    document.getElementById('addAllFolders').addEventListener('click', async () => {
      const button = document.getElementById('addAllFolders')
      button.disabled = true
      try {
        const folder = document.getElementById('folderPath').value.trim()
        if (!folder) throw new Error('Choose a parent folder or enter its path first.')
        const result = await api('/api/bots/import-folder', { method:'POST', body:JSON.stringify({ folder }) })
        notify(`Found ${result.found} bot folders; added ${result.added.length}.`)
        await refresh()
      } catch (err) { notify(err.message, true) } finally { button.disabled = false }
    })

    document.getElementById('bulkSettingsForm').addEventListener('submit', async event => {
      event.preventDefault()
      const status = document.getElementById('bulkSettingsStatus')
      try {
        const result = await api('/api/bots/bulk-settings', {
          method:'POST',
          body:JSON.stringify({ host:document.getElementById('bulkHost').value.trim(), port:Number(document.getElementById('bulkPort').value), version:document.getElementById('bulkVersion').value })
        })
        const skipped = result.skipped.length ? ` Skipped running bots: ${result.skipped.join(', ')}.` : ''
        status.textContent = `Applied ${result.host}:${result.port} (${result.version}) to ${result.updated.length} bot${result.updated.length === 1 ? '' : 's'}.${skipped}`
        notify(`Updated launch settings for ${result.updated.length} bots.`)
        await refresh()
      } catch (err) {
        status.textContent = err.message
        notify(err.message, true)
      }
    })

    document.getElementById('botGrid').addEventListener('click', async event => {
      const button = event.target.closest('button[data-action]')
      const card = button?.closest('.bot-card')
      if (!button || !card) return
      button.disabled = true
      try {
        const id = encodeURIComponent(card.dataset.id)
        if (button.dataset.action === 'save') {
          await saveCard(card)
          notify('Launch settings saved')
        } else if (button.dataset.action === 'start') {
          await saveCard(card)
          await api(`/api/bots/${id}/start`, { method:'POST', body:'{}' })
          notify('Bot terminal opened')
        } else if (button.dataset.action === 'stop') {
          await api(`/api/bots/${id}/stop`, { method:'POST', body:'{}' })
          notify('Bot stopped')
        } else if (button.dataset.action === 'folder') {
          const bot = state.bots.find(item => item.id === card.dataset.id)
          await api('/api/open-folder', { method:'POST', body:JSON.stringify({ folder:bot.folder }) })
        } else if (button.dataset.action === 'remove') {
          if (!confirm('Remove this bot from the Hub? Its folder will stay on disk.')) return
          await api(`/api/bots/${id}`, { method:'DELETE' })
          notify('Bot removed from Hub')
        }
        await refresh()
      } catch (err) {
        notify(err.message, true)
        button.disabled = false
      }
    })

    document.getElementById('broadcastForm').addEventListener('submit', async event => {
      event.preventDefault()
      const input = document.getElementById('broadcastInput')
      const status = document.getElementById('broadcastStatus')
      try {
        status.textContent = await sendHubInput(input.value)
        input.value = ''
      } catch (err) {
        status.textContent = err.message
      }
    })

    async function runAllBotsAction(action) {
      const startButton = document.getElementById('startAllBots')
      const stopButton = document.getElementById('stopAllBots')
      startButton.disabled = true
      stopButton.disabled = true
      try {
        const result = await api('/api/bots/action', {
          method:'POST',
          body:JSON.stringify({ action })
        })
        const skipped = result.skipped?.length ? ` Skipped: ${result.skipped.join(', ')}.` : ''
        const errors = result.errors?.length ? ` Errors: ${result.errors.map(item => `${item.bot}: ${item.error}`).join(' | ')}` : ''
        notify(`${action === 'start' ? 'Started' : 'Stopped'} ${result.bots.length} bot${result.bots.length === 1 ? '' : 's'}.${skipped}${errors}`, Boolean(result.errors?.length))
        await refresh()
      } catch (err) {
        notify(err.message, true)
      } finally {
        startButton.disabled = false
        stopButton.disabled = false
      }
    }

    document.getElementById('startAllBots').addEventListener('click', () => runAllBotsAction('start'))
    document.getElementById('stopAllBots').addEventListener('click', () => runAllBotsAction('stop'))

    document.getElementById('overviewTable').addEventListener('submit', async event => {
      const form = event.target.closest('.bot-send')
      if (!form) return
      event.preventDefault()
      const input = form.querySelector('input')
      const button = form.querySelector('button')
      button.disabled = true
      try {
        notify(await sendHubInput(input.value, [form.dataset.botId]))
        input.value = ''
      } catch (err) {
        notify(err.message, true)
      } finally {
        button.disabled = false
      }
    })

    function updateMergeSelection() {
      const inputs = [...document.querySelectorAll('#mergeList input[type="checkbox"]')]
      const selected = inputs.filter(input => input.checked)
      document.getElementById('mergeCount').textContent = `${selected.length} selected`
      document.getElementById('mergeButton').disabled = selected.length < 2
      for (const input of inputs) {
        const bot = state.bots.find(item => item.id === input.value)
        input.disabled = Boolean(bot?.status?.running)
      }
    }

    document.getElementById('mergeList').addEventListener('change', updateMergeSelection)
    document.getElementById('mergeButton').addEventListener('click', async () => {
      try {
        const botIds = [...document.querySelectorAll('#mergeList input:checked')].map(input => input.value)
        const result = await api('/api/merge', { method:'POST', body:JSON.stringify({ botIds }) })
        lastMergedFolder = result.output
        document.getElementById('openMerged').disabled = false
        const panel = document.getElementById('mergeResult')
        panel.className = 'notice good'
        panel.textContent = `Merged ${result.bots.length} bots and ${result.files.length} files into ${result.output}`
      } catch (err) {
        const panel = document.getElementById('mergeResult')
        panel.className = 'notice bad'
        panel.textContent = err.message
      }
    })

    document.getElementById('openMerged').addEventListener('click', async () => {
      try {
        await api('/api/open-folder', { method:'POST', body:JSON.stringify({ folder:lastMergedFolder }) })
      } catch (err) { notify(err.message, true) }
    })

    document.getElementById('mergedList').addEventListener('click', async event => {
      const openButton = event.target.closest('[data-open-merge]')
      if (openButton) {
        try {
          await api('/api/open-folder', { method:'POST', body:JSON.stringify({ folder:openButton.dataset.openMerge }) })
        } catch (err) { notify(err.message, true) }
        return
      }
      const applyButton = event.target.closest('[data-apply-merge]')
      if (!applyButton) return
      const mergeId = applyButton.dataset.applyMerge
      const botIds = [...(mergeTargets.get(mergeId) || [])]
      const bots = state.bots.filter(item => botIds.includes(item.id))
      if (!botIds.length) return notify('Choose at least one target bot first.', true)
      if (!confirm(`Replace knowledge for ${bots.map(bot => bot.name).join(', ')} with merge ${mergeId}? A backup will be created for every bot.`)) return
      applyButton.disabled = true
      try {
        const result = await api('/api/merge/apply', { method:'POST', body:JSON.stringify({ mergeId, botIds }) })
        notify(`Merged knowledge applied to ${result.bots.length} bots.`)
        document.getElementById('mergeResult').className = 'notice good'
        document.getElementById('mergeResult').textContent = `Applied ${mergeId} to ${result.bots.join(', ')}. Backups were created for every bot.`
      } catch (err) {
        notify(err.message, true)
      } finally {
        applyButton.disabled = false
      }
    })

    document.getElementById('mergedList').addEventListener('change', event => {
      const target = event.target.closest('[data-merge-target]')
      if (target) updateMergeTargets(target.dataset.mergeTarget)
    })

    async function saveConfig(patch) {
      await api('/api/config', { method:'POST', body:JSON.stringify(patch) })
      await refresh()
    }

    document.getElementById('addGroup').addEventListener('click', async () => {
      const name = document.getElementById('groupName').value.trim()
      if (name) await saveConfig({ groups:[...(state.groups || []), name] })
    })
    document.getElementById('addProfile').addEventListener('click', async () => {
      const profile = { id:crypto.randomUUID?.() || String(Date.now()), name:profileName.value.trim(), host:profileHost.value.trim(), port:Number(profilePort.value), version:profileVersion.value }
      if (profile.name && profile.host) await saveConfig({ serverProfiles:[...(state.serverProfiles || []), profile] })
    })
    document.getElementById('addSchedule').addEventListener('click', async () => {
      const schedule = { id:String(Date.now()), time:scheduleTime.value, action:scheduleAction.value, group:scheduleGroup.value, command:scheduleCommand.value, enabled:true }
      if (schedule.time && schedule.group) await saveConfig({ schedules:[...(state.schedules || []), schedule] })
    })
    document.getElementById('chatTargets').addEventListener('change', event => {
      const changed = event.target.closest('input[type="checkbox"]')
      if (!changed) return
      if (changed.value === 'all' && changed.checked) {
        document.querySelectorAll('#chatTargets input:not([value="all"])').forEach(input => { input.checked = false })
      } else if (changed.checked) {
        const all = document.querySelector('#chatTargets input[value="all"]')
        if (all) all.checked = false
      }
    })
    document.getElementById('chatForm').addEventListener('submit', async event => {
      event.preventDefault()
      const text = chatInput.value.trim()
      if (!text) return
      const botIds = selectedChatBotIds()
      try {
        notify(await sendHubInput(text, botIds))
        chatInput.value = ''
        setTimeout(refresh, 600)
      } catch (err) {
        notify(err.message, true)
      }
    })
    document.getElementById('groupList').addEventListener('click', async event => {
      const button = event.target.closest('[data-group-action]')
      const remove = event.target.closest('[data-group-delete]')
      if (remove) {
        if (!confirm(`Delete group ${remove.dataset.groupDelete}? Bots in this group will move to Ungrouped.`)) return
        await api('/api/group/delete', { method:'POST', body:JSON.stringify({ group:remove.dataset.groupDelete }) })
        notify(`Deleted group ${remove.dataset.groupDelete}.`)
        await refresh()
        return
      }
      if (!button) return
      const result = await api('/api/group/action', { method:'POST', body:JSON.stringify({ group:button.dataset.group, action:button.dataset.groupAction }) })
      notify(`${button.dataset.groupAction} requested for ${result.bots.length} bots.`)
    })
    document.getElementById('profileList').addEventListener('click', async event => {
      const button = event.target.closest('[data-apply-profile]')
      if (!button) return
      const botIds = [...document.querySelectorAll('#updateTargets input:checked')].map(input => input.value)
      await api('/api/server-profile/apply', { method:'POST', body:JSON.stringify({ profileId:button.dataset.applyProfile, botIds }) })
      notify(`Server profile applied to ${botIds.length} bots.`)
      await refresh()
    })
    document.getElementById('refreshScores').addEventListener('click', async () => {
      const result = await api('/api/knowledge-scores')
      scoreList.innerHTML = result.bots.map(bot => `<div class="item"><strong>${esc(bot.name)}</strong><span>${Object.entries(bot.scores).map(([name,score]) => `${name}: ${score}`).join(' | ')}</span></div>`).join('')
    })
    document.getElementById('updateSource').addEventListener('change', renderManage)
    document.getElementById('cloneBot').addEventListener('click', async () => {
      const sourceId = cloneSource.value
      const name = cloneName.value.trim()
      if (!sourceId) return notify('Choose a template bot first.', true)
      try {
        const result = await api(`/api/bots/${encodeURIComponent(sourceId)}/clone`, { method:'POST', body:JSON.stringify({ name }) })
        cloneName.value = ''
        notify(`Made ${result.bot.name}.`)
        await refresh()
      } catch (err) {
        notify(err.message, true)
      }
    })
    document.getElementById('refreshHealth').addEventListener('click', refreshHealth)
    document.getElementById('backupConfigNow').addEventListener('click', async () => {
      try {
        const result = await api('/api/config/backup', { method:'POST', body:'{}' })
        notify(`Config backup made: ${result.backup.name}`)
        await refreshHealth()
      } catch (err) {
        notify(err.message, true)
      }
    })
    document.getElementById('restoreConfigLatest').addEventListener('click', async () => {
      if (!confirm('Restore the newest config backup? A backup of the current config is made first.')) return
      try {
        const result = await api('/api/config/restore-latest', { method:'POST', body:'{}' })
        notify(`Restored config backup: ${result.restored.name}`)
        await refresh()
        await refreshHealth()
      } catch (err) {
        notify(err.message, true)
      }
    })
    document.getElementById('restartHub').addEventListener('click', async () => {
      if (!confirm('Restart only the Hub? Running bots will not be intentionally stopped.')) return
      try {
        await api('/api/restart-hub', { method:'POST', body:'{}' })
        notify('Hub restarting...')
        setTimeout(() => location.reload(), 3000)
      } catch (err) {
        notify(err.message, true)
      }
    })
    document.getElementById('refreshDiscord').addEventListener('click', refreshDiscord)
    document.getElementById('restartDiscord').addEventListener('click', async () => {
      if (!confirm('Restart only the Discord bridge?')) return
      try {
        const result = await api('/api/discord/restart', { method:'POST', body:'{}' })
        discord = result.discord
        renderDiscord()
        notify('Discord bridge restarting...')
        setTimeout(refreshDiscord, 2500)
      } catch (err) {
        notify(err.message, true)
      }
    })
    document.getElementById('testDiscord').addEventListener('click', async () => {
      try {
        const result = await api('/api/discord/test', { method:'POST', body:'{}' })
        notify(`Discord test sent to ${result.channelId}.`)
      } catch (err) {
        notify(err.message, true)
      }
    })
    document.getElementById('refreshLogs').addEventListener('click', async () => {
      const id = logBot.value
      if (!id) return
      const result = await api(`/api/logs/${encodeURIComponent(id)}?search=${encodeURIComponent(logSearch.value)}`)
      consoleLog.textContent = result.lines.join('\n') || 'No console output yet.'
      consoleLog.scrollTop = consoleLog.scrollHeight
    })
    document.getElementById('logSearch').addEventListener('input', () => document.getElementById('refreshLogs').click())
    document.getElementById('logBot').addEventListener('change', () => document.getElementById('refreshLogs').click())

    async function viewerAction(action, botIds = []) {
      if (action === 'off') {
        if (botIds.length) botIds.forEach(id => loadedViewers.delete(id))
        else loadedViewers.clear()
        viewerRenderKey = ''
        renderViewers(true)
      }
      const result = await api('/api/viewers/action', { method:'POST', body:JSON.stringify({ action, botIds }) })
      notify(`Viewer ${action} sent to ${result.sent.length} bot${result.sent.length === 1 ? '' : 's'}.`)
      setTimeout(refresh, 1000)
    }
    document.getElementById('allViewersOn').addEventListener('click', () => viewerAction('on'))
    document.getElementById('allViewersOff').addEventListener('click', () => viewerAction('off'))
    document.getElementById('viewerColumns').addEventListener('change', event => saveViewerLayout({ ...state.viewerLayout, columns:Number(event.target.value) }))
    document.getElementById('viewerGrid').addEventListener('click', async event => {
      const card = event.target.closest('[data-viewer-id]')
      if (!card) return
      const id = card.dataset.viewerId
      if (event.target.closest('[data-viewer-load]')) {
        loadedViewers.add(id)
        viewerRenderKey = ''
        return renderViewers(true)
      }
      if (event.target.closest('[data-viewer-toggle]')) {
        const action = event.target.closest('[data-viewer-toggle]').dataset.viewerToggle
        if (action === 'off') loadedViewers.delete(id)
        return viewerAction(action, [id])
      }
      if (event.target.closest('[data-viewer-hide]')) {
        const hidden = [...new Set([...(state.viewerLayout?.hidden || []), id])]
        return saveViewerLayout({ ...state.viewerLayout, hidden })
      }
    })
    let draggedViewerId = ''
    document.getElementById('viewerGrid').addEventListener('dragstart', event => {
      const card = event.target.closest('[data-viewer-id]')
      if (!card || event.target.closest('button')) return event.preventDefault()
      draggedViewerId = card.dataset.viewerId
      card.classList.add('dragging')
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', draggedViewerId)
    })
    document.getElementById('viewerGrid').addEventListener('dragover', event => {
      const card = event.target.closest('[data-viewer-id]')
      if (!card || card.dataset.viewerId === draggedViewerId) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      document.querySelectorAll('.viewer-card.drag-over').forEach(item => item.classList.remove('drag-over'))
      card.classList.add('drag-over')
    })
    document.getElementById('viewerGrid').addEventListener('dragleave', event => {
      const card = event.target.closest('[data-viewer-id]')
      if (card && !card.contains(event.relatedTarget)) card.classList.remove('drag-over')
    })
    document.getElementById('viewerGrid').addEventListener('drop', async event => {
      const target = event.target.closest('[data-viewer-id]')
      if (!target || !draggedViewerId || target.dataset.viewerId === draggedViewerId) return
      event.preventDefault()
      const order = orderedViewerBots().map(bot => bot.id)
      const from = order.indexOf(draggedViewerId)
      let to = order.indexOf(target.dataset.viewerId)
      const targetBox = target.getBoundingClientRect()
      const after = event.clientY > targetBox.top + targetBox.height / 2 || event.clientX > targetBox.left + targetBox.width / 2
      order.splice(from, 1)
      to = order.indexOf(target.dataset.viewerId) + (after ? 1 : 0)
      order.splice(to, 0, draggedViewerId)
      draggedViewerId = ''
      await saveViewerLayout({ ...state.viewerLayout, order })
    })
    document.getElementById('viewerGrid').addEventListener('dragend', () => {
      draggedViewerId = ''
      document.querySelectorAll('.viewer-card.dragging,.viewer-card.drag-over').forEach(item => item.classList.remove('dragging', 'drag-over'))
    })
    document.getElementById('hiddenCameras').addEventListener('click', event => {
      const button = event.target.closest('[data-viewer-show]')
      if (!button) return
      saveViewerLayout({ ...state.viewerLayout, hidden:(state.viewerLayout?.hidden || []).filter(id => id !== button.dataset.viewerShow) })
    })
    document.getElementById('runUpdate').addEventListener('click', async () => {
      try {
        const targetBotIds = [...document.querySelectorAll('#updateTargets input:checked')].map(input => input.value)
        const result = await api('/api/update-code', { method:'POST', body:JSON.stringify({ sourceBotId:updateSource.value, targetBotIds }) })
        notify(`Updated ${result.results.length} bots.`)
        await refresh()
      } catch (err) {
        notify(err.message, true)
      }
    })
    document.getElementById('restoreKnowledge').addEventListener('click', async () => {
      const result = await api('/api/knowledge/restore-latest', { method:'POST', body:JSON.stringify({ botId:restoreBot.value }) })
      notify(`Restored ${result.bot}.`)
    })
    document.getElementById('copyKnowledge').addEventListener('click', async () => {
      const sourceBotId = knowledgeSource.value
      const targetBotId = knowledgeTarget.value
      const source = state.bots.find(bot => bot.id === sourceBotId)
      const target = state.bots.find(bot => bot.id === targetBotId)
      if (!source || !target) return notify('Choose a source bot and a target bot first.', true)
      if (source.id === target.id) return notify('Choose two different bots.', true)
      if (!confirm(`Copy knowledge from ${source.name} to ${target.name}? The target knowledge gets a backup first.`)) return
      try {
        const result = await api('/api/knowledge/copy', { method:'POST', body:JSON.stringify({ sourceBotId, targetBotId }) })
        notify(`Copied knowledge from ${result.source} to ${result.target}.`)
        await refresh()
      } catch (err) {
        notify(err.message, true)
      }
    })

    addPanelInformation()
    activateTab(location.hash.slice(1) || 'overview', false)
    refresh().then(connectDashboardStream)
    const scheduleStatusRefresh=()=>setTimeout(async()=>{await refresh();scheduleStatusRefresh()},Number(state.dashboard?.statusUpdateIntervalMs||3000))
    scheduleStatusRefresh()
    setInterval(() => {
      if (document.getElementById('logs').classList.contains('active') && document.getElementById('logBot').value) document.getElementById('refreshLogs').click()
    }, 2000)
