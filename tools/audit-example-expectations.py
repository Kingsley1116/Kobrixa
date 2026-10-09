# Audit expectations for the 53 shipped examples; exits 1 for detected mismatches.
import json
import sys
from pathlib import Path
output = Path(sys.argv[1])
rs=json.load(open(output / 'results.json'))
expected={
'button-feedback':['Press an EV3 button','Button: E'],
'button-car':['Press Enter to drive'],
'sensor-dashboard':['Sensor: 42'],
'row-vector':['Row middle: 20','Vector doubled'],
'vector-workbench':['Vector prepared'],
'boolean-logic':['Ready to run'],
'break-and-continue':['Even values counted: 3'],
'comparison-operators':['Both tests passed'],
'if-elseif':['Level two'],
'labels-and-goto':['Reached Ready label'],
'display-fonts':['Tiny font','Small font','BIG'],
'display-write':['Simple black text','with LCD.Write'],
'double-buffer-animation':['Frame 1','Frame 2','Frame 3','Frame 4'],
'binary-record':['Byte: 42'],
'file-round-trip':['Hello from Kobrixa'],
'hello-ev3':['Hello from Kobrixa'],
'byte-logic':['13 AND 7 = 5','Hex: 05'],
'local-functions':['Double: 42'],
'import-functions':['Hello, Kobrixa'],
'import-module':['Steps: 360'],
'include-settings':['Using shared settings'],
'include-multiple':['Two includes loaded'],
'text-and-math':['2^8 = 256','Characters: 9'],
'mailbox-local':['Mailbox created'],
'brick-status':['AuditEV3','Battery: 75','Time: 1000'],
'program-end':['Program ending'],
'i2c-registers':['I2C ID: 42'],
'raw-and-mode':['Raw channel 0: 42'],
'sensor-details':['EV3-COLOR','Type/mode: 29/0','Raw 0: 42'],
'sensor-threshold':['Threshold is clear'],
'timer-slots':['Timer 1: 120'],
}
for r in rs:
 name=r['project'].split('/')[-1];tr=r['trace'];checks=[]
 def ck(desc,a,b):checks.append({'check':desc,'expected':b,'actual':a,'pass':a==b})
 def args(op,trace=tr):return [x['args'] for x in trace if x['op']==op]
 if name in expected:ck('display text', [a[3] for a in args('UI_DRAW.TEXT')],expected[name])
 if name in ['color-sensor','gyro-sensor']:ck('first numeric sensor display',args('UI_DRAW.VALUE')[0][3],42)
 if name=='control-flow':
  ck('circle X positions',[a[1] for a in args('UI_DRAW.CIRCLE')],[34,68,102,136]);ck('tone frequencies',[a[1] for a in args('SOUND.TONE')],[330,440,550,660])
 if name=='nested-control':ck('line Y positions',[a[2] for a in args('UI_DRAW.LINE')],[28,84]);ck('circle Y positions',[a[2] for a in args('UI_DRAW.CIRCLE')],[56])
 if name=='while-loop':ck('circle X positions',[a[1] for a in args('UI_DRAW.CIRCLE')],[22,55,88,121,154])
 if name=='case-insensitive':ck('circle X positions',[a[1] for a in args('UI_DRAW.CIRCLE')],[40,88,136])
 if name=='display-shapes':ck('circles',args('UI_DRAW.CIRCLE'),[[1,89,55,30],[1,89,55,14]]);ck('lines',args('UI_DRAW.LINE'),[[1,44,55,134,55],[1,89,10,89,100]])
 if name=='drawing-primitives':ck('drawing subcodes',[x['op'] for x in tr if x['op'].startswith('UI_DRAW.') and x['op'] not in ['UI_DRAW.CLEAN','UI_DRAW.UPDATE']],['UI_DRAW.PIXEL','UI_DRAW.RECT','UI_DRAW.FILLRECT','UI_DRAW.INVERSERECT','UI_DRAW.FILLCIRCLE'])
 if name=='speaker-scale':ck('tone frequencies',[a[1] for a in args('SOUND.TONE')],[220,330,440,550])
 if name=='speaker-interrupt':ck('sound command sequence',[x['op'] for x in tr if x['op'].startswith('SOUND.')],['SOUND.TONE','SOUND.BREAK','SOUND.TONE']);ck('tones',args('SOUND.TONE'),[[30,440,1200],[25,880,100]])
 if name=='speaker-melody':ck('tone frequencies',[a[1] for a in args('SOUND.TONE')],[262,330,392]);ck('wait count',len(args('SOUND_READY')),3)
 if name=='sensor-sampling':ck('high-sensor tones',[a[1] for a in args('SOUND.TONE',r['variants'][1]['trace'])],[880]*4);ck('sample count',len(args('SOUND.TONE')),4)
 if name=='obstacle-rover':ck('timeout delay count',len([x for x in tr if x['op']=='TIMER_WAIT']),50);ck('pressed sensor delay count',len([x for x in r['variants'][1]['trace'] if x['op']=='TIMER_WAIT']),0);ck('stop mask',args('OUTPUT_STOP')[-1],[0,9,1])
 if name=='thread-mutex':ck('worker LED',args('UI_WRITE.LED'),[[7]]);ck('main text',[a[3] for a in args('UI_DRAW.TEXT')],['Main is running'])
 moves={'motor-move':[[0,9,35,0,360,0,1]],'motor-reverse':[[0,1,-30,0,180,0,1]],'motor-sequence':[[0,1,30,0,180,0,1],[0,8,30,0,180,0,1]],'motor-schedule':[[0,9,25,60,360,60,1]]}
 if name in moves:ck('motor step parameters',args('OUTPUT_STEP_SPEED'),moves[name]);ck('motor waits',len(args('OUTPUT_READY')),len(moves[name]))
 if name=='motor-start-stop':ck('speed',args('OUTPUT_SPEED'),[[0,9,22]]);ck('brake',args('OUTPUT_STOP'),[[0,9,1]])
 if name=='motor-steer-sync':ck('sync operands',args('OUTPUT_STEP_SYNC'),[[0,9,35,25,360,1],[0,9,30,66,180,1]]);ck('wait count',len(args('OUTPUT_READY')),2)
 if name=='motor-counter':ck('positive branch',[a[3] for a in args('UI_DRAW.TEXT')],['Encoder is positive']);ck('zero branch',[a[3] for a in args('UI_DRAW.TEXT',r['variants'][0]['trace'])],['Encoder is zero/negative'])
 if name=='original-media':ck('bitmap path',args('UI_DRAW.BMPFILE')[0][3],'/home/root/lms2012/prjs/Kobrixa/assets/deploy/kobrixa-mascot.rgf');ck('sound path',args('SOUND.PLAY')[0][1],'assets/deploy/kobrixa-chime')
 if name=='double-buffer-animation':ck('one update per frame',len(args('UI_DRAW.UPDATE')),4)
 if name in ['raw-and-mode','sensor-details']:
  for variant in r['variants']:
   if variant['scenario']['sensor'] not in [-42,-2147483648]: continue
   value=variant['scenario']['sensor'];expected_value=0 if value==-2147483648 else value
   text=[a[3] for a in args('UI_DRAW.TEXT',variant['trace'])][-1]
   ck('raw sensor '+str(value),text,('Raw channel 0: ' if name=='raw-and-mode' else 'Raw 0: ')+str(expected_value))
 assert checks,name
 r['checks']=checks;r['verdict']='mismatch' if any(not x['pass'] for x in checks) else 'no mismatch in checked path'
 print(r['project'],r['verdict'])
json.dump(rs,open(output / 'checked-results.json','w'),ensure_ascii=False,indent=2)
print('mismatch',sum(r['verdict']=='mismatch' for r in rs),'total',len(rs))

sys.exit(1 if any(r["verdict"] == "mismatch" for r in rs) else 0)
