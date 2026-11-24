// Framework code never imports the author's module. The opaque frame gets only a port.
export function hostPage(secret: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>IPAB Web App</title></head>
<body><iframe title="Web App" sandbox="allow-scripts allow-forms" src="/frame/index.html" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>
<script nonce="${secret}">
const frame = document.querySelector("iframe");
let port, session, stopped = false;
async function post(path, data) {
  const response = await fetch(path, {method:"POST",headers:{"Content-Type":"application/json","X-IPAB-Web":"${secret}"},body:JSON.stringify(data),keepalive:path==="/disconnect"});
  if(!response.ok) throw Error("Bridge unavailable");
  return response.json();
}
function disconnect() {
  if(stopped) return;
  stopped=true;
  if(port) { port.postMessage({type:"closed"}); port.close(); }
  if(session) void post("/disconnect",{session}).catch(()=>{});
}
window.addEventListener("pagehide",disconnect);
window.addEventListener("message", async event => {
  if(event.source!==frame.contentWindow || event.origin!=="null" || event.data!=="ipab:connect" || port || stopped) return;
  const channel=new MessageChannel();
  port=channel.port1;
  try {
    session=(await post("/session",{})).session;
    if(stopped) { void post("/disconnect",{session}).catch(()=>{}); return; }
    port.onmessage=async ({data}) => {
      try {
        if(data && data.type==="close") { disconnect(); return; }
        const result=await post(data && data.type==="cancel"?"/cancel":"/call",{...data,session});
        if(result.type) port.postMessage(result);
      } catch { disconnect(); }
    };
    port.start();
    frame.contentWindow.postMessage("ipab:port","*",[channel.port2]);
    while(!stopped) {
      const result=await post("/poll",{session});
      for(const event of result.events) port.postMessage(event);
    }
  } catch { disconnect(); }
});
</script></body></html>`;
}
