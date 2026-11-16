using System;
using System.Diagnostics;
using System.Linq;
using System.Windows.Automation;

public static class WeChatUpdateDialog {
    static bool Exact(string text, params string[] names) {
        return names.Any(name => String.Equals((text ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase));
    }

    public static int Check(string executable, bool cancel) {
        var desktop = AutomationElement.RootElement;
        var matched = 0;
        InvokePattern cancelAction = null;
        foreach (AutomationElement window in desktop.FindAll(TreeScope.Children, Condition.TrueCondition)) {
            try {
                var current = window.Current;
                if (current.IsOffscreen) continue;
                using (var process = Process.GetProcessById(current.ProcessId)) {
                    if (!String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase)) continue;
                }
                bool updateTitle = Exact(current.Name, "微信更新", "微信升级", "WeChat Update", "Update WeChat");
                if (!updateTitle && !Exact(current.Name, "微信", "WeChat", "更新提示", "升级提示", "发现新版本", "软件更新", "Software Update")) continue;
                var children = window.FindAll(TreeScope.Descendants, new OrCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)));
                var controls = children.Cast<AutomationElement>().Where(item => !item.Current.IsOffscreen).ToArray();
                bool updateText = controls.Any(item => item.Current.ControlType == ControlType.Text &&
                    Exact(item.Current.Name, "发现新版本", "发现微信新版本", "微信有新版本可用", "微信版本过低，请更新后继续使用", "New version available", "A new version of WeChat is available"));
                var buttons = controls.Where(item => item.Current.ControlType == ControlType.Button && item.Current.IsEnabled &&
                    Exact(item.Current.Name, "取消", "暂不更新", "暂不升级", "以后再说", "稍后", "Cancel", "Not now", "Later")).ToArray();
                bool updateAction = controls.Any(item => item.Current.ControlType == ControlType.Button &&
                    Exact(item.Current.Name, "立即更新", "立即升级", "更新", "升级", "Update", "Update now", "Upgrade"));
                if (!updateTitle && !(updateText && updateAction)) continue;
                matched++;
                if (!cancel) continue;
                object pattern;
                if (buttons.Length != 1 || !buttons[0].TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) continue;
                cancelAction = (InvokePattern)pattern;
            } catch (ElementNotAvailableException) {} catch (InvalidOperationException) {} catch (System.ComponentModel.Win32Exception) {} catch (ArgumentException) {}
        }
        if (matched != 1 || cancelAction == null) return matched > 0 ? 1 : 0;
        cancelAction.Invoke();
        return 2;
    }
}
