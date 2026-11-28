const {app,BrowserWindow}=require('electron');
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1000,height:700,webPreferences:{sandbox:true}});
 w.webContents.on('render-process-gone',(_,d)=>{console.error('GONE',d);app.exit(1)});
 await w.loadURL('data:text/html;charset=utf-8,<textarea id="note" style="width:200px;height:100px">🙂界</textarea>');
 console.log('LOADED',w.webContents.getOSProcessId(),w.isFocused(),await w.webContents.executeJavaScript('document.querySelector("textarea").value'));
 await w.webContents.capturePage();
 w.focus();
 await new Promise(r=>setTimeout(r,1000));
 console.log('FOCUS',w.isFocused());
 w.webContents.sendInputEvent({type:'mouseDown',button:'left',x:50,y:50,clickCount:1});
 w.webContents.sendInputEvent({type:'mouseUp',button:'left',x:50,y:50,clickCount:1});
 await new Promise(r=>setTimeout(r,100));
 console.log('INPUT',await w.webContents.executeJavaScript('document.activeElement.id'));
 app.exit(0);
});
setTimeout(()=>app.exit(2),10000).unref();
