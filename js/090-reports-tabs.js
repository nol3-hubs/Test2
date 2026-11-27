    (function(){
      const root=document.getElementById("reports");
      if(!root||root.dataset.reportsTabsBound==="1")return;
      root.dataset.reportsTabsBound="1";
      const tabs=Array.from(root.querySelectorAll("[data-report-tab]"));
      const panels=Array.from(root.querySelectorAll("[data-report-panel]"));
      function activate(key,moveFocus){
        const tab=tabs.find(item=>item.dataset.reportTab===key);
        if(!tab)return;
        tabs.forEach(item=>{
          const active=item===tab;
          item.setAttribute("aria-selected",String(active));
          item.tabIndex=active?0:-1;
        });
        panels.forEach(panel=>{panel.hidden=panel.dataset.reportPanel!==key;});
        if(moveFocus)tab.focus();
      }
      function setStatus(button,message,kind){
        const panel=button.closest("[data-report-panel]");
        const status=panel&&panel.querySelector("[data-report-copy-status]");
        if(status){status.textContent=message;status.dataset.state=kind||"info";}
      }
      function cleanCell(value){
        if(value===null||value===undefined)return "";
        const result=typeof value==="object"?JSON.stringify(value):String(value);
        return result.replaceAll(String.fromCharCode(9)," ").replaceAll(String.fromCharCode(13)," ").replaceAll(String.fromCharCode(10)," ");
      }
      function rowsToTsv(rows){
        if(!Array.isArray(rows)||!rows.length)return "";
        const headers=[...new Set(rows.flatMap(row=>Object.keys(row||{})))].filter(key=>key!=="_area");
        if(!headers.length)return "";
        const tab=String.fromCharCode(9),lineBreak=String.fromCharCode(13,10);
        return [headers.map(cleanCell).join(tab),...rows.map(row=>headers.map(header=>cleanCell(row&&row[header])).join(tab))].join(lineBreak);
      }
      function tableToTsv(table){
        if(!table)return "";
        const tab=String.fromCharCode(9),lineBreak=String.fromCharCode(13,10);
        return Array.from(table.querySelectorAll("tr")).map(row=>Array.from(row.querySelectorAll("th,td")).map(cell=>cleanCell(cell.innerText||cell.textContent)).join(tab)).filter(row=>row.trim()).join(lineBreak);
      }
      async function copyText(button,payload,successMessage){
        if(!payload){setStatus(button,"No source data is loaded for this copy action yet.","warn");return false;}
        let copied=false;
        try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(payload);copied=true;}}catch(_){}
        if(!copied){
          const area=document.createElement("textarea");
          area.value=payload;area.setAttribute("readonly","");
          area.style.position="fixed";area.style.left="-9999px";area.style.top="0";
          document.body.appendChild(area);area.select();
          try{copied=document.execCommand("copy");}catch(_){copied=false;}
          area.remove();
        }
        setStatus(button,copied?successMessage:"Copy failed. Check browser clipboard permissions.",copied?"success":"error");
        return copied;
      }
      function optionalRows(globalName){
        const value=window[globalName];
        return Array.isArray(value)?value:[];
      }

      let assignmentTaskReportButton=null;
      let assignmentTaskExportPending=false;
      let assignmentTaskReportWatchdog=null;
      function clearAssignmentTaskReportWatchdog(){
        if(assignmentTaskReportWatchdog)clearTimeout(assignmentTaskReportWatchdog);
        assignmentTaskReportWatchdog=null;
      }
      function armAssignmentTaskReportWatchdog(timeoutMs,message){
        clearAssignmentTaskReportWatchdog();
        assignmentTaskReportWatchdog=setTimeout(()=>{
          assignmentTaskReportWatchdog=null;
          if(assignmentTaskExportPending)finishAssignmentTaskReportError(message);
        },timeoutMs);
      }
      function assignmentTaskReportDate(){
        try{
          if(typeof getBadocManilaDayBounds==="function")return getBadocManilaDayBounds().date;
          return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Manila",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
        }catch(_){return new Date().toISOString().slice(0,10);}
      }
      function finishAssignmentTaskReportError(message){
        clearAssignmentTaskReportWatchdog();
        assignmentTaskExportPending=false;
        const button=assignmentTaskReportButton;
        assignmentTaskReportButton=null;
        if(button){
          button.disabled=false;
          button.textContent="⧉ Assignment Task";
          setStatus(button,message||"SPX Assignment Task export failed.","error");
        }
        window.dispatchEvent(new CustomEvent("badoc:assignment-task-error",{detail:{message:String(message||"SPX Assignment Task export failed.")}}));
      }

      let batchSearchReportButton=null;
      let batchSearchExportPending=false;
      let batchSearchReportWatchdog=null;
      function clearBatchSearchReportWatchdog(){
        if(batchSearchReportWatchdog)clearTimeout(batchSearchReportWatchdog);
        batchSearchReportWatchdog=null;
      }
      function armBatchSearchReportWatchdog(timeoutMs,message){
        clearBatchSearchReportWatchdog();
        batchSearchReportWatchdog=setTimeout(()=>{
          batchSearchReportWatchdog=null;
          if(batchSearchExportPending)finishBatchSearchReportError(message);
        },timeoutMs);
      }
      function finishBatchSearchReportError(message){
        clearBatchSearchReportWatchdog();
        batchSearchExportPending=false;
        const button=batchSearchReportButton;
        batchSearchReportButton=null;
        if(button){
          button.disabled=false;
          button.textContent="⧉ Batch Search Result";
          setStatus(button,message||"SPX Batch Search Result export failed.","error");
        }
      }
      function extractAssignmentTaskSpXTrackingNumbers(rows){
        if(!Array.isArray(rows)||!rows.length)throw new Error("Run Assignment Task first and wait for its CSV to load.");
        const first=rows.find(row=>row&&typeof row==="object")||{};
        const headers=Object.keys(first);
        const normalize=value=>String(value??"").normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
        const aliases=new Set(["SPX Tracking Number","SPX tracking num","SPX TN","SPX Tracking No","Tracking Number","Tracking No"].map(normalize));
        let key=headers.find(header=>aliases.has(normalize(header)));
        if(!key){
          const fuzzy=headers.filter(header=>{
            const name=normalize(header);
            return name.includes("spx")&&(name.includes("trackingnumber")||name.includes("trackingnum")||name.endsWith("tn")||name.endsWith("trackingno"));
          });
          if(fuzzy.length===1)key=fuzzy[0];
        }
        if(!key){
          throw new Error("The Assignment Task CSV has no recognizable SPX Tracking Number column. Available columns: "+headers.join(", "));
        }
        const unique=new Map();
        let invalid=0;
        rows.forEach(row=>{
          const value=String(row?.[key]??"").trim().replace(/\s+/g,"").toUpperCase();
          if(!value)return;
          if(!/^[A-Z0-9_-]{6,60}$/.test(value)){invalid++;return;}
          if(!unique.has(value))unique.set(value,value);
        });
        if(!unique.size)throw new Error("No usable SPX Tracking Numbers were found in the Assignment Task CSV column "+key+".");
        return {numbers:[...unique.values()],column:key,invalid};
      }

      window.addEventListener("message",event=>{
        if(event.source!==window)return;
        const data=event.data||{};
        if(data.source!=="BADOC_SPX_BRIDGE")return;
        if(data.type==="BADOC_BRIDGE_DISCONNECTED"&&assignmentTaskExportPending){
          finishAssignmentTaskReportError("Badoc Hub Extension disconnected during the Assignment Task export. Reload the extension in chrome://extensions, refresh Badoc Hub, and retry.");
          return;
        }
        if(data.type==="BADOC_BRIDGE_DISCONNECTED"&&batchSearchExportPending){
          finishBatchSearchReportError("Badoc Hub Extension disconnected during SPX Batch Search. Reload the extension in chrome://extensions, refresh Badoc Hub, and retry.");
          return;
        }
        if(data.type==="BADOC_SPX_COMMAND_FORWARDED"&&data.kind==="assignment-task"){
          if(assignmentTaskReportButton){
            armAssignmentTaskReportWatchdog(15000,"The extension page bridge forwarded the Assignment Task command, but the background service worker did not acknowledge it within 15 seconds. Open chrome://extensions → Badoc Hub Extension → Service worker → Inspect, check for errors, then reload the extension and retry.");
            setStatus(assignmentTaskReportButton,data.message||"Assignment Task command forwarded. Waiting for the extension background worker…","info");
          }
          return;
        }
        if(data.type==="BADOC_SPX_COMMAND_FORWARDED"&&data.kind==="batch-search-result"){
          if(batchSearchReportButton){
            armBatchSearchReportWatchdog(15000,"The Batch Search command reached the extension page bridge, but the background service worker did not acknowledge it within 15 seconds. Reload Badoc Hub Extension v1.5.33 and refresh Badoc Hub.");
            setStatus(batchSearchReportButton,data.message||"Batch Search command forwarded. Waiting for the extension background worker…","info");
          }
          return;
        }
        if(data.type==="BADOC_SPX_BATCH_SEARCH_PROGRESS"){
          if(batchSearchReportButton){
            armBatchSearchReportWatchdog(8*60*1000,"SPX Batch Search stopped reporting progress for 8 minutes. Check the Order Tracking tab and extension service worker, then retry.");
            setStatus(batchSearchReportButton,data.message||"Running SPX Batch Search and export…","info");
          }
          return;
        }
        if(data.type==="BADOC_SPX_BATCH_SEARCH_CSV"){
          clearBatchSearchReportWatchdog();
          try{
            const rows=typeof parseCsvText==="function"?parseCsvText(String(data.csvText||"")):[];
            if(!rows.length)throw new Error("SPX returned an empty Batch-Search Results file.");
            window.__badocBatchSearchResultRows=rows;
            window.__badocBatchSearchResultMeta={
              selectedDate:String(data.selectedDate||assignmentTaskReportDate()),
              sourceTaskId:String(data.sourceTaskId||""),
              inputCount:Number(data.inputCount||0),
              chunkCount:Number(data.chunkCount||1),
              rowCount:Number(data.rowCount||rows.length),
              matchedCount:Number(data.matchedCount||0),
              notFoundCount:Number(data.notFoundCount||0),
              failedCount:Number(data.failedCount||0),
              failedBatchCount:Number(data.failedBatchCount||0),
              fileName:String(data.fileName||"batch_search_result.csv"),
              savedAt:Date.now()
            };
            batchSearchExportPending=false;
            const button=batchSearchReportButton;
            batchSearchReportButton=null;
            if(button){
              button.disabled=false;
              button.textContent="⧉ Batch Search Result ("+rows.length.toLocaleString()+")";
              const meta=window.__badocBatchSearchResultMeta;
              const summary="Completed "+meta.inputCount.toLocaleString()+" unique TN(s) · "+meta.matchedCount.toLocaleString()+" found · "+meta.notFoundCount.toLocaleString()+" not found"+(meta.failedCount?" · "+meta.failedCount.toLocaleString()+" failed":"")+". Click again to copy.";
              setStatus(button,summary,meta.failedCount?"warn":"success");
            }
          }catch(error){finishBatchSearchReportError(error?.message||String(error));}
          return;
        }
        if(data.type==="BADOC_SPX_BATCH_SEARCH_ERROR"){
          finishBatchSearchReportError(data.message||"SPX Batch Search Result export failed.");
          return;
        }
        if(data.type==="BADOC_SPX_ERROR"&&data.kind==="batch-search-result"){
          finishBatchSearchReportError(data.message||"SPX Batch Search Result export failed.");
          return;
        }
        if(data.type==="BADOC_SPX_ASSIGNMENT_TASK_PROGRESS"){
          if(assignmentTaskReportButton){
            armAssignmentTaskReportWatchdog(6*60*1000,"Assignment Task export stopped reporting progress for 6 minutes. Check the Badoc Hub Extension service worker in chrome://extensions, reload the extension, refresh Badoc Hub, and retry.");
            setStatus(assignmentTaskReportButton,data.message||"Exporting Assignment Task directly from SPX…","info");
          }
          return;
        }
        if(data.type==="BADOC_SPX_ASSIGNMENT_TASK_CSV"){
          clearAssignmentTaskReportWatchdog();
          try{
            const rows=typeof parseCsvText==="function"?parseCsvText(String(data.csvText||"")):[];
            if(!rows.length)throw new Error("SPX returned an empty Assignment Task file.");
            window.__badocAssignmentTaskRows=rows;
            window.__badocAssignmentTaskMeta={
              selectedDate:String(data.selectedDate||assignmentTaskReportDate()),
              taskId:String(data.taskId||""),
              fileName:String(data.fileName||"assignment_task.csv"),
              savedAt:Date.now()
            };
            window.dispatchEvent(new CustomEvent("badoc:assignment-task-updated",{detail:{date:window.__badocAssignmentTaskMeta.selectedDate,rowCount:rows.length}}));
            assignmentTaskExportPending=false;
            const button=assignmentTaskReportButton;
            assignmentTaskReportButton=null;
            if(button){
              button.disabled=false;
              button.textContent="⧉ Assignment Task ("+rows.length.toLocaleString()+")";
              setStatus(button,"Loaded "+rows.length.toLocaleString()+" Assignment Task row(s) from SPX · "+window.__badocAssignmentTaskMeta.selectedDate+". Click again to copy.","success");
            }
          }catch(error){finishAssignmentTaskReportError(error?.message||String(error));}
          return;
        }
        if(data.type==="BADOC_SPX_ASSIGNMENT_TASK_ERROR"){
          finishAssignmentTaskReportError(data.message||"SPX Assignment Task export failed.");
          return;
        }
        if(data.type==="BADOC_SPX_ERROR"&&data.kind==="assignment-task"){
          finishAssignmentTaskReportError(data.message||"SPX Assignment Task export failed.");
        }
      });

      // Fallback reader for the exact locally saved SPX Pickup exports used by
      // the Pickup menu. Reports must not depend on a Pickup-page DOM element.
      const reportPickupDateFormatter=new Intl.DateTimeFormat("en-CA",{
        timeZone:"Asia/Manila",year:"numeric",month:"2-digit",day:"2-digit"
      });
      const reportPickupNorm=value=>String(value??"").normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
      function reportPickupValue(row,aliases,pattern){
        const keys=Object.keys(row||{});
        const normalized=new Map(keys.map(key=>[reportPickupNorm(key),key]));
        for(const alias of aliases){
          const key=normalized.get(reportPickupNorm(alias));
          if(key)return String(row[key]??"").trim();
        }
        if(pattern){
          const key=keys.find(name=>pattern.test(reportPickupNorm(name)));
          if(key)return String(row[key]??"").trim();
        }
        return "";
      }
      function reportPickupDateKey(value){
        const raw=String(value??"").trim();
        if(!raw)return "";
        const direct=raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if(direct)return `${direct[1]}-${String(direct[2]).padStart(2,"0")}-${String(direct[3]).padStart(2,"0")}`;
        const slash=raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
        if(slash)return `${slash[3]}-${String(slash[1]).padStart(2,"0")}-${String(slash[2]).padStart(2,"0")}`;
        let date=null;
        if(/^\d+(\.\d+)?$/.test(raw)){
          const number=Number(raw);
          if(number>100000000000)date=new Date(number);
          else if(number>1000000000)date=new Date(number*1000);
          else if(number>20000&&number<80000)date=new Date(Date.UTC(1899,11,30)+number*86400000);
        }else{
          date=new Date(raw.includes("T")?raw:raw.replace(/\s+/,"T"));
        }
        return date&&!Number.isNaN(date.getTime())?reportPickupDateFormatter.format(date):"";
      }
      function reportStoredPickupRows(kind){
        const storageKey=kind==="orders"
          ?"badoc_first_mile_orders_csv_local_v1"
          :"badoc_first_mile_tasks_csv_local_v1";
        let record=null;
        try{record=JSON.parse(localStorage.getItem(storageKey)||"null");}catch(_){}
        if(!record?.csvText||typeof parseCsvText!=="function")return [];
        const rows=parseCsvText(record.csvText);
        const today=typeof getBadocManilaDayBounds==="function"
          ?getBadocManilaDayBounds().date
          :reportPickupDateFormatter.format(new Date());
        return rows.filter(row=>{
          const rawDate=kind==="orders"
            ?reportPickupValue(row,["ETA","Estimated Time of Arrival","Estimated Arrival Time","Pickup ETA","Pickup Estimated Time","eta_date","eta_time","estimated_arrival_time"],/^eta(date|time)?$/i)
            :reportPickupValue(row,["Create Time","Task Create Time","Created Time","create_time","ctime"],/^createtime$|^taskcreatetime$|^ctime$/i);
          return reportPickupDateKey(rawDate)===today;
        });
      }
      async function copyStoredPickupExport(kind,button,label){
        const rows=reportStoredPickupRows(kind);
        if(!rows.length){
          setStatus(button,kind==="orders"
            ?"No Pickup Orders with ETA today are saved on this device. Sync Pickup Orders + Tasks in the Pickup menu first."
            :"No Pickup Tasks created today are saved on this device. Sync Pickup Orders + Tasks in the Pickup menu first.","warn");
          return false;
        }
        await copyText(button,rowsToTsv(rows),"Copied "+rows.length.toLocaleString()+" row(s) from the saved Pickup export: "+label+".");
        return true;
      }

      // Keep LM HUB INVENTORY aligned with the actual Planning Board dataset.
      // getParcelCountRows() merges the uploaded Parcel Count records with the
      // latest Forward/Return status snapshots and applies Planning Board rules.
      const lmInventoryHeaders=[
        "Order ID","SLS Tracking Number","Shopee Order SN","Longitude","Latitude",
        "Sort Code Name","Town Name","Location Type","Driver ID","Driver Name",
        "Driver Phone","Received Time","Current Station Received Time","Delivering Time",
        "Delivered Time","OnHold Time","OnHoldReason","Reschedule Date","Status",
        "Reject remark","COD Amount","Manifest Number","Order Account","Original ASF",
        "Rounding ASF","Total of On Hold Times","Reschedule Time","Delivery Attempts",
        "Bulky Type","SLA Target Date","Time to SLA","Payment Method","Current Station",
        "Shop ID","Shop Category","Zone ID","Zone","Destination Station","Next Station",
        "Pickup Station","Ros","Driver Contract Type","Pick Up Time","Collected Time",
        "Transported to sp time","SLA Tag","High Value","Specical Dg Type","Damaged Tag",
        "Return Destination","Chargeable Weight","Cache Type","Size Type"
      ];
      const lmInventoryStatusKeys=[
        "Parcel Status To","Status To","TO Status","To Status","Status To (Current)","Status"
      ];
      function lmInventoryStatusValue(row){
        for(const key of lmInventoryStatusKeys){
          if(row&&Object.prototype.hasOwnProperty.call(row,key)&&String(row[key]??"").trim()){
            return String(row[key]).trim();
          }
        }
        const key=Object.keys(row||{}).find(name=>/parcel\s*status\s*to|status\s*to|to\s*status/i.test(name));
        return key?String(row[key]??"").trim():"";
      }
      function lmInventoryStatusKey(value){
        return String(value??"").trim().toUpperCase().replace(/[_-]+/g," ").replace(/\s+/g," ").trim();
      }
      async function copyLmHubInventory(button){
        // Wait for the saved Forward/Return status snapshot to finish restoring
        // before reading the same merged rows used by Planning Board.
        if(window.__badocOnholdExportsReady)await window.__badocOnholdExportsReady;
        if(typeof getParcelCountRows!=="function"){
          setStatus(button,"Planning Board data source is unavailable on this page.","error");
          return;
        }
        const planningRows=getParcelCountRows();
        if(!Array.isArray(planningRows)||!planningRows.length){
          setStatus(button,"No Planning Board parcel data is loaded. Load the Parcel Count data first.","warn");
          return;
        }
        const allowedStatuses=new Set([
          "DELIVERING","DELIVERED","ONHOLD","ON HOLD","LMHUB ONHOLD","LMHUB ON HOLD"
        ]);
        const filtered=planningRows.filter(row=>{
          const station=String(row?.["Current Station"]??"").trim().replace(/\s+/g," ").toUpperCase();
          if(station!=="BADOC HUB")return false;
          return allowedStatuses.has(lmInventoryStatusKey(lmInventoryStatusValue(row)));
        });
        if(!filtered.length){
          setStatus(button,"No Planning Board rows match Delivering, Delivered, or OnHold with Current Station = Badoc Hub.","warn");
          return;
        }
        const outputRows=filtered.map(row=>{
          const output={};
          const planningStatus=lmInventoryStatusValue(row);
          lmInventoryHeaders.forEach(header=>{
            // The Inventory sheet has a single Status column. Put the Planning
            // Board's effective status there (including its OnHold mapping).
            output[header]=header==="Status"?planningStatus:(row?.[header]??"");
          });
          return output;
        });
        await copyText(
          button,
          rowsToTsv(outputRows),
          "Copied "+filtered.length.toLocaleString()+" Planning Board row(s) for LM HUB INVENTORY · Delivering, Delivered, OnHold · Current Station: Badoc Hub."
        );
      }
      root.addEventListener("click",async event=>{
        const tab=event.target.closest("[data-report-tab]");
        if(tab&&root.contains(tab)){activate(tab.dataset.reportTab,false);return;}
        const button=event.target.closest("[data-report-copy]");
        if(!button||!root.contains(button))return;
        const key=button.dataset.reportCopy;
        button.disabled=true;
        try{
          if(key==="lm-inventory"){
            await copyLmHubInventory(button);
          }else if(key==="fm-inventory"||key==="pickup-task-management"){
            const pickupCopySource=window.__badocCopyPickupRawExportRows;
            const kind=key==="fm-inventory"?"orders":"tasks";
            const label=key==="fm-inventory"?"FM Hub Inventory":"Pickup Task Management";
            if(typeof pickupCopySource==="function"){
              await pickupCopySource(kind,button,label);
            }else{
              // Read the same saved CSV and use the Pickup menu's date rule and TSV format.
              await copyStoredPickupExport(kind,button,label);
            }
          }else if(key==="assignment-task"){
            const rows=optionalRows("__badocAssignmentTaskRows");
            const meta=window.__badocAssignmentTaskMeta||{};
            const today=assignmentTaskReportDate();
            if(rows.length&&meta.selectedDate===today){
              await copyText(button,rowsToTsv(rows),"Copied "+rows.length.toLocaleString()+" Assignment Task row(s) from SPX · Created Date: "+today+".");
            }else if(assignmentTaskExportPending){
              setStatus(button,"SPX Assignment Task export is already running. Wait for the export result.","warn");
            }else{
              const ensureBridge=window.__badocEnsureSpxBridge;
              if(typeof ensureBridge!=="function"){
                setStatus(button,"The Badoc Hub extension check is unavailable on this page. Refresh Badoc Hub and retry.","error");
                return;
              }
              setStatus(button,"Checking Badoc Hub Extension v1.5.23 and preparing the direct SPX export…","info");
              const bridgeReady=await ensureBridge();
              if(!bridgeReady){
                setStatus(button,"Badoc Hub Extension v1.5.23 or later is required. Install or reload the extension, then refresh Badoc Hub and retry.","error");
                return;
              }
              assignmentTaskExportPending=true;
              assignmentTaskReportButton=button;
              button.textContent="Fetching Assignment Task…";
              setStatus(button,"Submitting Created Date "+today+" directly to SPX (no SPX tab required)…","info");
              if(typeof postBadocSpxMessage!=="function"){
                finishAssignmentTaskReportError("SPX bridge is not available on this dashboard page.");
              }else{
                armAssignmentTaskReportWatchdog(15000,"The installed SPX extension did not forward the Assignment Task export command. This Test2 extension bundle currently lacks that command handler; the automatic rider mapping cannot complete until the extension bridge supports Assignment Task export.");
                postBadocSpxMessage("BADOC_START_ASSIGNMENT_TASK_EXPORT",{selectedDate:today});
              }
            }
          }else if(key==="batch-search-result"){
            const resultRows=optionalRows("__badocBatchSearchResultRows");
            const resultMeta=window.__badocBatchSearchResultMeta||{};
            const today=assignmentTaskReportDate();
            if(resultRows.length&&resultMeta.selectedDate===today){
              await copyText(button,rowsToTsv(resultRows),"Copied "+resultRows.length.toLocaleString()+" Batch Search result row(s) to the clipboard.");
            }else if(batchSearchExportPending){
              setStatus(button,"SPX Batch Search is already running. Wait for the export result.","warn");
            }else{
              const assignmentRows=optionalRows("__badocAssignmentTaskRows");
              const assignmentMeta=window.__badocAssignmentTaskMeta||{};
              if(!assignmentRows.length||assignmentMeta.selectedDate!==today){
                setStatus(button,"Run Assignment Task first and wait for today's CSV to load. Batch Search uses its SPX Tracking Number column.","warn");
                return;
              }
              const extracted=extractAssignmentTaskSpXTrackingNumbers(assignmentRows);
              const ensureBridge=window.__badocEnsureSpxBridge;
              if(typeof ensureBridge!=="function"){
                setStatus(button,"The Badoc Hub extension check is unavailable. Refresh Badoc Hub and retry.","error");
                return;
              }
              setStatus(button,"Checking Badoc Hub Extension v1.5.33 and preparing "+extracted.numbers.length.toLocaleString()+" SPX Tracking Number(s)…","info");
              const bridgeReady=await ensureBridge();
              if(!bridgeReady){
                setStatus(button,"Badoc Hub Extension v1.5.33 or later is required. Install or reload the extension, then refresh Badoc Hub.","error");
                return;
              }
              batchSearchExportPending=true;
              batchSearchReportButton=button;
              button.textContent="Searching SPX…";
              setStatus(button,"Using "+extracted.numbers.length.toLocaleString()+" unique SPX Tracking Number(s) from Assignment Task column "+extracted.column+". SPX supports 3,000 per search; larger lists will run in chunks.","info");
              armBatchSearchReportWatchdog(15000,"The Batch Search command was not forwarded to the extension within 15 seconds. Reload the extension and refresh Badoc Hub.");
              if(typeof postBadocSpxMessage!=="function"){
                finishBatchSearchReportError("SPX bridge is not available on this dashboard page.");
              }else{
                postBadocSpxMessage("BADOC_START_BATCH_SEARCH_EXPORT",{
                  selectedDate:today,
                  sourceTaskId:String(assignmentMeta.taskId||""),
                  trackingNumbers:extracted.numbers
                });
              }
            }
          }else if(key==="hourly"){
            const rows=optionalRows("__badocHourlyRows"),table=document.querySelector("#hourlyReportTable");
            const payload=rows.length?rowsToTsv(rows):tableToTsv(table);
            const count=rows.length||Math.max(0,table?table.querySelectorAll("tbody tr").length:0);
            if(!payload||!count){
              setStatus(button,"Hourly data source is not connected to this Reports build yet. No matching rows or report table are registered.","warn");
            }else{
              await copyText(button,payload,"Copied "+count.toLocaleString()+" hourly row(s).");
            }
          }else if(key==="pickup"){
            const existing=document.getElementById("copyFirstMileForSheet");
            if(existing&&!existing.disabled){
              existing.click();
              setStatus(button,"Pickup Copy for Sheet action started. Check the Pickup page for its final copy result.","info");
            }else setStatus(button,"No Pickup rows are loaded. Sync Pickup Orders + Tasks first.","warn");
          }else if(key==="performance"){
            if(typeof renderRiderPerformance==="function")renderRiderPerformance();
            const table=document.querySelector("#dailyRiderPerformance .performance-table");
            const payload=tableToTsv(table);
            const count=table?table.querySelectorAll("tbody tr").length:0;
            await copyText(button,payload,count?"Copied "+count.toLocaleString()+" rider performance row(s).":"");
          }else if(key==="consolidated"){
            const result=typeof mergeAllBatches==="function"?mergeAllBatches():null;
            const rows=Array.isArray(result&&result.rows)?result.rows:[];
            await copyText(button,rowsToTsv(rows),rows.length?"Copied "+rows.length.toLocaleString()+" consolidated parcel row(s).":"");
          }
        }catch(error){
          setStatus(button,"Copy failed: "+String(error&&error.message||error),"error");
        }finally{
          if((key==="assignment-task"&&assignmentTaskExportPending)||(key==="batch-search-result"&&batchSearchExportPending)){
            button.disabled=true;
          }else{
            button.disabled=false;
          }
        }
      });
      window.__badocRequestAssignmentTaskExport = function(options = {}) {
        const date = String(options.date || assignmentTaskReportDate());
        const rows = optionalRows("__badocAssignmentTaskRows");
        const meta = window.__badocAssignmentTaskMeta || {};
        if (rows.length && meta.selectedDate === date && options.force !== true) {
          window.dispatchEvent(new CustomEvent("badoc:assignment-task-updated",{detail:{date,rowCount:rows.length,reused:true}}));
          return {ok:true,reused:true,rowCount:rows.length,date};
        }
        if (assignmentTaskExportPending) return {ok:true,pending:true,date};
        const button = root.querySelector('[data-report-copy="assignment-task"]');
        if (!button) return {ok:false,message:"The existing SPX Assignment Task export control is missing from Reports."};
        // Invoke the same authenticated SPX export flow already used by Reports.
        button.click();
        return {ok:true,requested:true,date};
      };
      root.addEventListener("keydown",event=>{
        const current=event.target.closest("[data-report-tab]");
        if(!current)return;
        const index=tabs.indexOf(current);
        let next=index;
        if(event.key==="ArrowRight")next=(index+1)%tabs.length;
        else if(event.key==="ArrowLeft")next=(index-1+tabs.length)%tabs.length;
        else if(event.key==="Home")next=0;
        else if(event.key==="End")next=tabs.length-1;
        else return;
        event.preventDefault();
        activate(tabs[next].dataset.reportTab,true);
      });
    })();
  
