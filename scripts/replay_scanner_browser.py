#!/usr/bin/env python3
"""Replay the real scanner UI (requires Python Playwright and local Chrome).

Start `npm run dev`, then run this script. No expected plate text is supplied to
OCR. The output retains observed candidates, publication events and screenshots;
it is evidence for manual comparison, not a labelled accuracy score.
"""
import argparse
import asyncio
import json
import re
import time
from pathlib import Path
from playwright.async_api import async_playwright


async def replay(args):
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    labels = json.loads(Path(args.labels).read_text()) if args.labels else {}
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel='chrome', headless=True)
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        if args.backend == 'wasm':
            await page.add_init_script("Object.defineProperty(navigator, 'gpu', {get: () => undefined})")
        events = []
        started = time.monotonic()

        async def log(message):
            if message.type not in ('warning', 'error') and not message.text.startswith(('[OCR:', '[ANPR:', '[ANPR YoloDetector]', '[ANPR Quality]', '[ANPR Environment]', '[PP-OCR]', '[Scanner:')):
                return
            try:
                events.append({'elapsed': round(time.monotonic() - started, 3),
                               'type': message.type, 'text': message.text,
                               'args': [await value.json_value() for value in message.args]})
            except Exception:
                pass  # The page can unload while a console argument is being read.

        page.on('console', log)
        page.on('pageerror', lambda error: events.append({'type': 'pageerror', 'text': str(error)}))
        await page.goto(args.url)
        await page.get_by_role('button', name='Diagnostics', exact=True).click()
        for index, clip in enumerate(args.clips):
            events.clear()
            started = time.monotonic()
            ended_at = None
            error = None
            try:
                selector = page.locator('select').filter(has=page.locator('option[value="clip-2"]'))
                await selector.select_option(f'clip-{clip}')
                # Source changes resume the prepared scanner automatically.
                # Only the first source needs a Mula click; never restart a clip.
                if index == 0:
                    await page.get_by_role('button', name=re.compile(r'^MULA$', re.I)).click()
                await page.wait_for_timeout(500)
                await page.wait_for_function("() => { const v = document.querySelector('video'); return v && v.ended; }", timeout=90000)
                ended_at = round(time.monotonic() - started, 3)
                await page.get_by_role('button', name=re.compile(r'^MULA$', re.I)).wait_for(state='visible', timeout=60000)
                await page.wait_for_timeout(250)
            except Exception as exception:
                error = str(exception)
            body = await page.locator('body').inner_text()
            result = {'clip': clip, 'backend': args.backend, 'endedAt': ended_at,
                      'completedAt': round(time.monotonic() - started, 3), 'error': error,
                      'results': body.split('SENARAI PENGESANAN TERKINI')[-1], 'events': events.copy()}
            cards = result['results'].split('NOMBOR PLAT')[0]
            published = sorted(set(plate for plate in re.findall(r'(?m)^([A-Z0-9]{2,10})$', cards)
                                   if re.search('[A-Z]', plate) and re.search('[0-9]', plate)))
            result['publishedPlates'] = published
            if str(clip) in labels:
                expected = sorted(labels[str(clip)])
                result['verification'] = {
                    'expected': expected,
                    'correct': sorted(set(expected) & set(published)),
                    'missing': sorted(set(expected) - set(published)),
                    'unexpected': sorted(set(published) - set(expected)),
                    'passed': error is None and expected == published,
                }
            (output / f'clip-{clip}.json').write_text(json.dumps(result, indent=2))
            (output / f'clip-{clip}.txt').write_text(body)
            await page.screenshot(path=str(output / f'clip-{clip}.png'), full_page=True)
            print(f'Clip {clip}: ' + ('ERROR ' + error if error else result['results'].splitlines()[1]), flush=True)
            if error:
                break
        await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://localhost:3000/scanner')
    parser.add_argument('--clips', type=int, nargs='+', default=[2, 20, 11, 16])
    parser.add_argument('--backend', choices=['wasm', 'auto'], default='wasm')
    parser.add_argument('--labels', help='JSON mapping clip numbers to manually verified plates; used only for reporting')
    parser.add_argument('--output', default='/tmp/scanner-browser-replay')
    asyncio.run(replay(parser.parse_args()))
