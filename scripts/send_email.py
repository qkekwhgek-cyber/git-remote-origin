import smtplib
import os
import sys
import glob
import re
import html as html_mod
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

def find_latest_report():
    files = sorted(glob.glob('daily-reports/*.md'))
    if not files:
        print('ERROR: daily-reports/ 에 .md 파일이 없습니다')
        sys.exit(1)
    return files[-1]

def md_to_html(md):
    lines = md.split('\n')
    out = []
    for raw in lines:
        line = html_mod.escape(raw)
        if line.startswith('# '):
            out.append(f'<h1 style="color:#1a1a2e">{line[2:]}</h1>')
        elif line.startswith('## '):
            out.append(f'<h2 style="color:#333;border-bottom:2px solid #eee;padding-bottom:4px">{line[3:]}</h2>')
        elif line.strip() == '---':
            out.append('<hr style="border:none;border-top:1px solid #eee;margin:16px 0">')
        elif line.strip() == '':
            out.append('<br>')
        else:
            line = re.sub(
                r'\[([^\]]+)\]\(([^)]+)\)',
                r'<a href="\2" style="color:#1a73e8;text-decoration:none">\1</a>',
                line
            )
            line = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', line)
            out.append(f'<p style="margin:4px 0;line-height:1.6">{line}</p>')

    body = '\n'.join(out)
    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
             max-width:700px;margin:0 auto;padding:24px;background:#fff;color:#222">
{body}
</body>
</html>"""

def send_report():
    user = os.environ['GMAIL_USER']
    password = os.environ['GMAIL_PASSWORD']

    report_file = find_latest_report()
    date = os.path.basename(report_file).replace('.md', '')

    with open(report_file, 'r', encoding='utf-8') as f:
        md_content = f.read()

    html_content = md_to_html(md_content)

    msg = MIMEMultipart('alternative')
    msg['Subject'] = f'일일 트렌드 리포트 - {date}'
    msg['From'] = user
    msg['To'] = user

    msg.attach(MIMEText(md_content, 'plain', 'utf-8'))
    msg.attach(MIMEText(html_content, 'html', 'utf-8'))

    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as smtp:
        smtp.login(user, password)
        smtp.send_message(msg)

    print(f'이메일 발송 완료: {date} → {user}')

if __name__ == '__main__':
    send_report()
