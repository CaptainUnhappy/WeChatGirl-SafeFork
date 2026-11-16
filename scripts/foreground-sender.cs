// Independent foreground text sender. Uses Windows UI Automation only.
using System;
using System.Linq;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Windows.Forms;

public static class WhaleForeground {
  public static bool Attempted=false;
  static Random random=new Random();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd,int command);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,IntPtr processId);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint thread,uint other,bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [StructLayout(LayoutKind.Sequential)] struct ScreenPoint { public int X,Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(ScreenPoint point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
  static AutomationElement Find(AutomationElement root, string id) {
    return root.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.AutomationIdProperty,id));
  }
  static AutomationElement Window(string exe) {
    exe=System.IO.Path.GetFullPath(exe);
    var candidates=Process.GetProcesses().Where(p=>{try{return p.MainWindowHandle!=IntPtr.Zero&&String.Equals(p.MainModule.FileName,exe,StringComparison.OrdinalIgnoreCase);}catch{return false;}}).ToArray();
    if(candidates.Length!=1)throw new Exception("FOREGROUND_WINDOW_AMBIGUOUS");
    return AutomationElement.FromHandle(candidates[0].MainWindowHandle);
  }
  static void Fill(AutomationElement e,string text) {
    object value;
    if(!e.TryGetCurrentPattern(ValuePattern.Pattern,out value))throw new Exception("FOREGROUND_VALUE_UNAVAILABLE");
    ((ValuePattern)value).SetValue(text);
  }
  static AutomationElement SearchBox(AutomationElement root) {
    return root.FindFirst(TreeScope.Descendants,new AndCondition(new PropertyCondition(AutomationElement.NameProperty,"搜索"),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit)));
  }
  static AutomationElement ChatTab(AutomationElement root) {
    var toolbar=Find(root,"MainView.main_tabbar");
    if(toolbar==null)return null;
    var tabs=toolbar.FindAll(TreeScope.Descendants,new AndCondition(
      new PropertyCondition(AutomationElement.ClassNameProperty,"mmui::XTabBarItem"),
      new PropertyCondition(AutomationElement.NameProperty,"微信")));
    return tabs.Count==1?tabs[0]:null;
  }
  static void EnsureChatPage(AutomationElement root,IntPtr handle) {
    if(Find(root,"chat_input_field")!=null||SearchBox(root)!=null)return;
    // Qt advertises InvokePattern for this tab, but invoking it does not switch pages.
    if(!ClickInWindow(ChatTab(root),handle,false))throw new Exception("FOREGROUND_CHAT_TAB_UNAVAILABLE");
    for(int attempt=0;attempt<20;attempt++) {
      if(GetForegroundWindow()!=handle)throw new Exception("FOREGROUND_FOCUS_CHANGED");
      if(Find(root,"chat_input_field")!=null||SearchBox(root)!=null)return;
      Thread.Sleep(100);
    }
    throw new Exception("FOREGROUND_CHAT_PAGE_UNAVAILABLE");
  }
  static bool ClickInWindow(AutomationElement element,IntPtr handle,bool submitting,bool searchPopup=false) {
    System.Windows.Point point;
    if(element==null||!element.TryGetClickablePoint(out point))return false;
    var target=new ScreenPoint { X=(int)point.X,Y=(int)point.Y };
    if(GetForegroundWindow()!=handle)return false;
    if(searchPopup) {
      var hit=AutomationElement.FromPoint(new System.Windows.Point(target.X,target.Y));
      if(hit==null||hit.Current.ProcessId!=element.Current.ProcessId||!Automation.Compare(hit,element))return false;
    } else if(GetAncestor(WindowFromPoint(target),2)!=handle)return false;
    if(!SetCursorPos(target.X,target.Y)||GetForegroundWindow()!=handle)return false;
    if(submitting)Attempted=true;
    mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);
    return true;
  }
  public static bool Probe(string exe) {
    var root=Window(exe);
    var input=Find(root,"chat_input_field");
    var search=SearchBox(root);var tab=ChatTab(root);
    object value;System.Windows.Point point;
    return (input!=null&&input.TryGetCurrentPattern(ValuePattern.Pattern,out value)) || (search!=null&&search.TryGetCurrentPattern(ValuePattern.Pattern,out value)) || (tab!=null&&tab.TryGetClickablePoint(out point));
  }
  // Follow the local DeepSeekGirl driver's activation sequence for a verified window.
  static bool ActivateWindow(IntPtr handle) {
    if(IsIconic(handle))ShowWindowAsync(handle,9);
    SetForegroundWindow(handle);
    Thread.Sleep(100);
    if(GetForegroundWindow()==handle&&!IsIconic(handle))return true;
    for(int attempt=0;attempt<3;attempt++) {
      var foreground=GetForegroundWindow();
      uint current=GetCurrentThreadId();
      uint owner=foreground==IntPtr.Zero?0:GetWindowThreadProcessId(foreground,IntPtr.Zero);
      bool attached=owner!=0&&owner!=current&&AttachThreadInput(current,owner,true);
      try {
        ShowWindowAsync(handle,IsIconic(handle)?9:5);
        BringWindowToTop(handle);
        SetForegroundWindow(handle);
      } finally {
        if(attached)AttachThreadInput(current,owner,false);
      }
      Thread.Sleep(100);
      if(GetForegroundWindow()==handle&&!IsIconic(handle))return true;
    }
    return false;
  }
  static AutomationElement OpenChat(string exe,string name) {
    var root=Window(exe);var handle=new IntPtr(root.Current.NativeWindowHandle);
    if(!ActivateWindow(handle))throw new Exception("FOREGROUND_FOCUS_REQUIRED");
    EnsureChatPage(root,handle);
    var input=Find(root,"chat_input_field");
    if(input==null||input.Current.Name!=name){
      var search=SearchBox(root);
      if(search==null)throw new Exception("FOREGROUND_SEARCH_UNAVAILABLE");
      search.SetFocus();
      if(GetForegroundWindow()!=handle||!search.Current.HasKeyboardFocus)throw new Exception("FOREGROUND_FOCUS_CHANGED");
      Fill(search,name);
      AutomationElement result=null;
      for(int attempt=0;attempt<30;attempt++) {
        if(GetForegroundWindow()!=handle)throw new Exception("FOREGROUND_FOCUS_CHANGED");
        var list=Find(root,"search_list");
        if(list!=null&&ReadInput(search)==name) {
          var results=list.FindAll(TreeScope.Descendants,Condition.TrueCondition).Cast<AutomationElement>()
            .Where(e=>e.Current.AutomationId.StartsWith("search_item_")&&e.Current.Name.Split('\n')[0].Trim()==name&&Visible(e)).ToArray();
          if(results.Length>1)throw new Exception("FOREGROUND_TARGET_AMBIGUOUS");
          if(results.Length==1){result=results[0];break;}
        }
        Thread.Sleep(100);
      }
      if(result==null)throw new Exception("FOREGROUND_SEARCH_EMPTY");
      if(!ClickInWindow(result,handle,false,true))throw new Exception("FOREGROUND_SEARCH_RESULT_UNCLICKABLE");
      for(int attempt=0;attempt<40;attempt++) {
        if(GetForegroundWindow()!=handle)throw new Exception("FOREGROUND_FOCUS_CHANGED");
        root=AutomationElement.FromHandle(handle);
        input=Find(root,"chat_input_field");
        if(input!=null&&input.Current.Name==name)break;
        Thread.Sleep(100);
      }
    }
    if(input==null||input.Current.Name!=name||GetForegroundWindow()!=handle)throw new Exception("FOREGROUND_TARGET_CHANGED");
    return root;
  }
  static AutomationElement EmptyInput(AutomationElement root,string name){
    var input=Find(root,"chat_input_field");
    if(input==null||input.Current.Name!=name)throw new Exception("FOREGROUND_TARGET_CHANGED");
    object pattern;
    // Never overwrite a user's unsent draft.
    if(!input.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)||!String.IsNullOrEmpty(((ValuePattern)pattern).Current.Value))throw new Exception("FOREGROUND_DRAFT_PRESENT");
    return input;
  }
  public static bool Send(string exe,string name,string text) {
    var root=OpenChat(exe,name);var handle=new IntPtr(root.Current.NativeWindowHandle);var input=EmptyInput(root,name);
    input.SetFocus();Fill(input,text);
    try {
      if(input.Current.Name!=name||GetForegroundWindow()!=handle||!input.Current.HasKeyboardFocus)throw new Exception("FOREGROUND_FOCUS_CHANGED");
      if(ReadInput(input)!=text)throw new Exception("FOREGROUND_DRAFT_MISMATCH");
      var button=SendButton(root);
      if(input.Current.Name!=name||ReadInput(input)!=text||!ClickInWindow(button,handle,true))throw new Exception("FOREGROUND_SEND_BUTTON_UNAVAILABLE");
    } catch {
      // Remove only the text we staged, and only while the same input is still focused.
      if(!Attempted)try {
        if(GetForegroundWindow()==handle&&input.Current.HasKeyboardFocus&&input.Current.Name==name&&ReadInput(input)==text)Fill(input,"");
      }catch{}
      throw;
    }
    return true; // Submission only. The parent confirms using the message database.
  }
  static string ReadInput(AutomationElement input) {
    return ((ValuePattern)input.GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
  }
  public static bool SendAttachment(string exe,string name,string file) {
    file=System.IO.Path.GetFullPath(file);
    if(!System.IO.File.Exists(file))throw new Exception("FOREGROUND_ATTACHMENT_MISSING");
    string filename=System.IO.Path.GetFileName(file);
    var root=OpenChat(exe,name);var handle=new IntPtr(root.Current.NativeWindowHandle);
    var input=EmptyInput(root,name);
    input.SetFocus();
    if(GetForegroundWindow()!=handle||!input.Current.HasKeyboardFocus)throw new Exception("FOREGROUND_FOCUS_CHANGED");
    var previous=Clipboard.GetDataObject();
    var drop=new System.Collections.Specialized.StringCollection();drop.Add(file);
    try {
      Clipboard.SetFileDropList(drop);
      uint stagedClipboard=GetClipboardSequenceNumber();
      if(GetForegroundWindow()!=handle||!input.Current.HasKeyboardFocus||input.Current.Name!=name||ReadInput(input)!="")throw new Exception("FOREGROUND_TARGET_CHANGED");
      SendKeys.SendWait("^v");
      for(int attempt=0;attempt<25;attempt++){
        if(GetForegroundWindow()!=handle||input.Current.Name!=name)throw new Exception("FOREGROUND_TARGET_CHANGED");
        if(GetClipboardSequenceNumber()!=stagedClipboard)throw new Exception("FOREGROUND_CLIPBOARD_CHANGED");
        // Qt 4.1.15.13 exposes a pasted file as one inline object, without its filename.
        // The input was empty before the single-file clipboard paste.
        bool verified=ReadInput(input)=="\uFFFC"||Controls(input).Any(e=>Visible(e)&&e.Current.ControlType!=ControlType.Edit&&e.Current.Name==filename);
        if(verified){
          if(ClickInWindow(SendButton(root),handle,true))return true;
          if(!input.Current.HasKeyboardFocus)throw new Exception("FOREGROUND_FOCUS_CHANGED");
          Attempted=true;SendKeys.SendWait("{ENTER}");return true;
        }
        Thread.Sleep(100);
      }
      throw new Exception("FOREGROUND_ATTACHMENT_NOT_VERIFIED");
    } finally {
      try{
        var current=Clipboard.GetFileDropList();
        if(current.Count==1&&current[0]==file){
          if(previous!=null)Clipboard.SetDataObject(previous,true);else Clipboard.Clear();
        }
      }catch{}
    }
  }
  static AutomationElement SendButton(AutomationElement root) {
    var buttons=root.FindAll(TreeScope.Descendants,new AndCondition(
      new PropertyCondition(AutomationElement.NameProperty,"发送"),
      new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button)))
      .Cast<AutomationElement>().Where(button=>Visible(button)&&button.Current.IsEnabled).ToArray();
    return buttons.Length==1?buttons[0]:null;
  }
  static bool HasQuote(AutomationElement root,string text){
    return Controls(root).Any(e=>Visible(e)&&e.Current.Name.StartsWith("引用 ",StringComparison.Ordinal)&&
      (text==null||e.Current.Name.EndsWith(" 的消息 : "+text,StringComparison.Ordinal)));
  }
  static readonly System.Text.RegularExpressions.Regex VideoLabel=new System.Text.RegularExpressions.Regex(
    @"^\s*(?:\[视频\]|视频|\[Video\]|Video)(?:\s+(?<download>下载|Download))?(?:[\s:：]*(?<duration>(?:[0-9]{1,3}[:：])?[0-9]{1,3}[:：][0-9]{2}))?\s*$",
    System.Text.RegularExpressions.RegexOptions.IgnoreCase|System.Text.RegularExpressions.RegexOptions.CultureInvariant);
  static readonly System.Text.RegularExpressions.Regex VideoClock=new System.Text.RegularExpressions.Regex(
    @"^\s*(?:[0-9]{1,3}[:：])?[0-9]{1,3}[:：][0-9]{2}\s*$");
  static int VideoSeconds(string duration){
    if(String.IsNullOrEmpty(duration))return -1;
    int seconds=0;
    foreach(var part in duration.Split(':','：'))seconds=seconds*60+Int32.Parse(part,System.Globalization.CultureInfo.InvariantCulture);
    return seconds;
  }
  static int DisplayedVideoSeconds(AutomationElement bubble,string labelDuration){
    if(!String.IsNullOrEmpty(labelDuration))return VideoSeconds(labelDuration);
    var clocks=Controls(bubble).Where(e=>!e.Current.IsOffscreen).Select(e=>e.Current.Name??"").Where(label=>VideoClock.IsMatch(label))
      .Select(VideoSeconds).Distinct().ToArray();
    return clocks.Length==1?clocks[0]:-1;
  }
  static bool ScrollVideoHistory(AutomationElement list,IntPtr handle){
    if(list==null||!Visible(list)||GetForegroundWindow()!=handle)return false;
    var area=list.Current.BoundingRectangle;
    var point=new ScreenPoint { X=(int)(area.X+area.Width/2),Y=(int)(area.Y+area.Height/2) };
    if(GetAncestor(WindowFromPoint(point),2)!=handle)return false;
    var hit=AutomationElement.FromPoint(new System.Windows.Point(point.X,point.Y));
    var walker=TreeWalker.RawViewWalker;
    while(hit!=null&&!Automation.Compare(hit,list))hit=walker.GetParent(hit);
    if(hit==null||!SetCursorPos(point.X,point.Y)||GetForegroundWindow()!=handle)return false;
    mouse_event(0x0800,0,0,120,UIntPtr.Zero);
    return true;
  }
  static bool ClickVideoThumbnail(AutomationElement bubble,AutomationElement list,IntPtr handle,int previousClicks){
    var bounds=bubble.Current.BoundingRectangle;
    var viewport=list.Current.BoundingRectangle;
    double horizontalOffset=(96+previousClicks*24)*Math.Max(1,GetDpiForWindow(handle)/96.0);
    var target=new ScreenPoint { X=(int)(bounds.Left+horizontalOffset),Y=(int)(bounds.Top+bounds.Height*0.57) };
    if(!bounds.Contains(target.X,target.Y)||!viewport.Contains(target.X,target.Y)||GetForegroundWindow()!=handle||GetAncestor(WindowFromPoint(target),2)!=handle)return false;
    var hit=AutomationElement.FromPoint(new System.Windows.Point(target.X,target.Y));
    var walker=TreeWalker.RawViewWalker;
    while(hit!=null&&!Automation.Compare(hit,bubble))hit=walker.GetParent(hit);
    if(hit==null||!SetCursorPos(target.X,target.Y)||GetForegroundWindow()!=handle)return false;
    mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);
    return true;
  }
  static string VideoMessagePattern(AutomationElement bubble,bool video){
    if(video)return "v";
    if(bubble.Current.ClassName!="mmui::ChatTextItemView")return null;
    string text=System.Text.RegularExpressions.Regex.Replace(bubble.Current.Name??"",@"\s+"," ").Trim();
    if(text.Length==0||text.Length>160)return null;
    using(var hash=System.Security.Cryptography.SHA256.Create())
      return "t:"+BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant();
  }
  static bool MatchesVideoAnchor(string[] patterns,int start,string[] anchor){
    if(anchor.Length==0||start<0||start+anchor.Length>patterns.Length)return false;
    return anchor.SequenceEqual(patterns.Skip(start).Take(anchor.Length));
  }
  public static bool OpenVideo(string exe,string name,int seconds,int[] displaySeconds,bool onlyVideo,int previousClicks,string[] before,string[] after){
    if(previousClicks<0||previousClicks>2)throw new Exception("FOREGROUND_VIDEO_TARGET_INVALID");
    var root=OpenChat(exe,name);
    var handle=new IntPtr(root.Current.NativeWindowHandle);
    for(int attempt=0;attempt<8;attempt++){
      root=AutomationElement.FromHandle(handle);
      var input=Find(root,"chat_input_field");
      if(input==null||input.Current.Name!=name||GetForegroundWindow()!=handle)throw new Exception("FOREGROUND_TARGET_CHANGED");
      var list=Find(root,"chat_message_list");
      var rows=(list==null?new AutomationElement[0]:Controls(list)).Where(e=>Visible(e)&&e.Current.AutomationId.EndsWith(".chat_bubble_item_view",StringComparison.Ordinal))
        .OrderBy(e=>e.Current.BoundingRectangle.Top).Select(e=>new {Element=e,Label=VideoLabel.Match(e.Current.Name??"")}).ToArray();
      var patterns=rows.Select(row=>VideoMessagePattern(row.Element,row.Label.Success)).ToArray();
      var bubbles=rows.Where(e=>e.Label.Success).ToArray();
      var matches=rows.Where((row,index)=>row.Label.Success&&
        (MatchesVideoAnchor(patterns,index-before.Length,before)||MatchesVideoAnchor(patterns,index+1,after))).ToArray();
      if(matches.Length==0)matches=bubbles.Where(e=>{
        int displayed=DisplayedVideoSeconds(e.Element,e.Label.Groups["duration"].Value);
        return displayed>=0&&seconds>0?displaySeconds.Contains(displayed):onlyVideo&&bubbles.Length==1;
      }).ToArray();
      if(matches.Length==1){
        var match=matches[0];
        if(previousClicks>0&&!match.Label.Groups["download"].Success)throw new Exception("FOREGROUND_VIDEO_DOWNLOAD_LABEL_GONE");
        if(input.Current.Name!=name||!ClickVideoThumbnail(match.Element,list,handle,previousClicks))throw new Exception("FOREGROUND_VIDEO_TARGET_UNCLICKABLE");
        return true;
      }
      if(matches.Length>1)break;
      // New messages can push the target out of the recycler's visible rows.
      if(attempt>=3&&(attempt==7||!ScrollVideoHistory(list,handle)))break;
      Thread.Sleep(attempt>=3?300:150);
    }
    throw new Exception("FOREGROUND_VIDEO_TARGET_NOT_UNIQUE");
  }
  public static bool SendQuote(string exe,string name,string text,string original){
    if(String.IsNullOrEmpty(original)||original.Length>500||original.Contains("\n"))throw new Exception("FOREGROUND_QUOTE_INVALID");
    var root=OpenChat(exe,name);var handle=new IntPtr(root.Current.NativeWindowHandle);
    var input=EmptyInput(root,name);
    if(HasQuote(root,null))throw new Exception("FOREGROUND_DRAFT_PRESENT");
    var bubbles=Controls(root).Where(e=>Visible(e)&&e.Current.AutomationId.EndsWith(".chat_bubble_item_view",StringComparison.Ordinal)&&e.Current.Name==original).ToArray();
    if(bubbles.Length!=1)throw new Exception("FOREGROUND_QUOTE_TARGET_NOT_UNIQUE");
    System.Windows.Point point;
    if(!bubbles[0].TryGetClickablePoint(out point))throw new Exception("FOREGROUND_QUOTE_TARGET_UNCLICKABLE");
    var hit=new ScreenPoint {X=(int)point.X,Y=(int)point.Y};
    if(GetForegroundWindow()!=handle||GetAncestor(WindowFromPoint(hit),2)!=handle||!SetCursorPos(hit.X,hit.Y)||GetForegroundWindow()!=handle)throw new Exception("FOREGROUND_TARGET_CHANGED");
    mouse_event(8,0,0,0,UIntPtr.Zero);mouse_event(16,0,0,0,UIntPtr.Zero);
    AutomationElement menu=null;
    for(int i=0;i<15&&menu==null;i++){
      var process=AutomationElement.FromHandle(GetForegroundWindow());
      if(process.Current.ProcessId!=root.Current.ProcessId)throw new Exception("FOREGROUND_FOCUS_CHANGED");
      var found=Controls(process).Where(e=>Visible(e)&&e.Current.Name=="引用"&&e.Current.AutomationId=="XMenuItem").ToArray();
      if(found.Length==1)menu=found[0];
      Thread.Sleep(70);
    }
    if(menu==null)throw new Exception("FOREGROUND_QUOTE_MENU_UNAVAILABLE");
    var menuRect=menu.Current.BoundingRectangle;
    var menuPoint=new ScreenPoint {X=(int)(menuRect.Left+menuRect.Width/2),Y=(int)(menuRect.Top+menuRect.Height/2)};
    var menuWindow=WindowFromPoint(menuPoint);
    var menuHit=AutomationElement.FromHandle(menuWindow);
    if(menuHit==null||menuHit.Current.ProcessId!=root.Current.ProcessId||!SetCursorPos(menuPoint.X,menuPoint.Y))throw new Exception("FOREGROUND_QUOTE_MENU_UNAVAILABLE");
    mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);
    for(int i=0;i<15&&!HasQuote(root,original);i++)Thread.Sleep(70);
    if(GetForegroundWindow()!=handle||input.Current.Name!=name||!HasQuote(root,original)||ReadInput(input)!="")throw new Exception("FOREGROUND_QUOTE_PREVIEW_MISMATCH");
    input.SetFocus();Fill(input,text);
    if(GetForegroundWindow()!=handle||input.Current.Name!=name||ReadInput(input)!=text||!HasQuote(root,original))throw new Exception("FOREGROUND_QUOTE_PREVIEW_MISMATCH");
    if(!ClickInWindow(SendButton(root),handle,true)){
      if(!input.Current.HasKeyboardFocus)throw new Exception("FOREGROUND_FOCUS_CHANGED");
      Attempted=true;SendKeys.SendWait("{ENTER}");
    }
    return true;
  }
  static bool Visible(AutomationElement e){var r=e.Current.BoundingRectangle;return !e.Current.IsOffscreen&&!r.IsEmpty&&r.Width>=16&&r.Height>=16;}
  static AutomationElement[] Controls(AutomationElement root){return root.FindAll(TreeScope.Descendants,Condition.TrueCondition).Cast<AutomationElement>().ToArray();}
  static AutomationElement Panel(AutomationElement root){
    var panel=Controls(root).FirstOrDefault(e=>Visible(e)&&(e.Current.ClassName.ToLowerInvariant()=="mmui::emoticonpanel"||e.Current.ClassName.ToLowerInvariant()=="mmui::emoticonpopover"));
    if(panel!=null)return panel;
    return AutomationElement.RootElement.FindAll(TreeScope.Children,Condition.TrueCondition).Cast<AutomationElement>().FirstOrDefault(e=>e.Current.ProcessId==root.Current.ProcessId&&Visible(e)&&(e.Current.ClassName.ToLowerInvariant()=="mmui::emoticonpanel"||e.Current.ClassName.ToLowerInvariant()=="mmui::emoticonpopover"));
  }
  static AutomationElement[] Favorites(AutomationElement panel,bool generic){return Controls(panel).Where(e=>{
    var cls=e.Current.ClassName.ToLowerInvariant();var r=e.Current.BoundingRectangle;
    return Visible(e)&&r.Width<=320&&r.Height<=320&&(cls=="mmui::favemoticonitemview"||e.Current.AutomationId.ToLowerInvariant().Contains("favemoticon")||generic&&(cls=="mmui::emoticonitemview"||cls=="mmui::commonemoticonview"));
  }).ToArray();}
  static bool ClickStickerControl(AutomationElement element,AutomationElement panel,bool submitting){
    System.Windows.Point point;
    if(element==null||!element.TryGetClickablePoint(out point))return false;
    var foreground=GetForegroundWindow();
    if(foreground==IntPtr.Zero||AutomationElement.FromHandle(foreground).Current.ProcessId!=panel.Current.ProcessId)return false;
    var hit=AutomationElement.FromPoint(point);
    while(hit!=null&&hit.Current.ProcessId==panel.Current.ProcessId&&!Automation.Compare(hit,element)){
      if(Automation.Compare(hit,panel))return false;
      hit=TreeWalker.RawViewWalker.GetParent(hit);
    }
    if(hit==null||!Automation.Compare(hit,element)||!SetCursorPos((int)point.X,(int)point.Y)||GetForegroundWindow()!=foreground)return false;
    if(submitting)Attempted=true;
    mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);
    return true;
  }
  public static bool SendFavorite(string exe,string name){
    var root=OpenChat(exe,name);EmptyInput(root,name);
    var launcher=Controls(root).FirstOrDefault(e=>Visible(e)&&(e.Current.AutomationId=="chat_text_emoticon_view"||e.Current.Name=="发送表情"||e.Current.Name=="发送表情(Alt+E)"||e.Current.Name=="表情"||e.Current.ClassName=="mmui::EmoticonView"));
    var panel=Panel(root);
    if(panel==null){
      var handle=new IntPtr(root.Current.NativeWindowHandle);
      if(launcher==null||GetForegroundWindow()!=handle)throw new Exception("FOREGROUND_STICKER_PANEL_UNAVAILABLE");
      if(launcher.Current.Name=="发送表情(Alt+E)")SendKeys.SendWait("%e");
      else if(!ClickInWindow(launcher,handle,false))throw new Exception("FOREGROUND_STICKER_PANEL_UNAVAILABLE");
      for(int attempt=0;attempt<10&&panel==null;attempt++){Thread.Sleep(100);panel=Panel(root);}
    }
    if(panel==null)throw new Exception("FOREGROUND_STICKER_PANEL_UNAVAILABLE");
    var items=Favorites(panel,false);
    if(items.Length==0){
      var tab=Controls(panel).FirstOrDefault(e=>Visible(e)&&e.Current.ClassName.ToLowerInvariant()=="mmui::emoticontoolbaritem"&&(e.Current.Name.Contains("收藏")||e.Current.Name.Contains("添加的表情")||e.Current.Name.Contains("自定义表情")||(e.Current.AutomationId+e.Current.Name).ToLowerInvariant().Contains("fav")));
      if(!ClickStickerControl(tab,panel,false))throw new Exception("FOREGROUND_FAVORITES_TAB_UNAVAILABLE");
      for(int attempt=0;attempt<12&&items.Length==0;attempt++){
        Thread.Sleep(100);panel=Panel(root);if(panel!=null)items=Favorites(panel,true);
      }
    }
    if(items.Length==0)throw new Exception("FOREGROUND_FAVORITES_EMPTY");
    EmptyInput(root,name);
    int start=random.Next(items.Length);
    for(int i=0;i<items.Length;i++)if(ClickStickerControl(items[(start+i)%items.Length],panel,true))return true;
    throw new Exception("FOREGROUND_FAVORITE_NOT_CLICKED");
  }
}
