# 2026 年本地 AI 工作站：四種硬體架構的取捨

資料查閱日：2026-09-28。**先確認模型、量化、脈絡長度與軟體，再買硬體。** 以下以本地大型語言模型推論為主，兼談微調；規格頻寬、容量推估與實測速度分開處理。

容量可先算「參數量 × 位元數 ÷ 8」：70B 模型全部以 4-bit 儲存，純權重約 35GB（十進位），尚須加量化中繼資料、KV cache、暫存及系統餘裕。長脈絡與多人同用會增加需求，訓練還需要梯度等額外空間。速度則分為處理提示的 prefill 與逐步生成的 decode；低 batch 的 decode 常受記憶體頻寬限制，prefill 常較偏算力，不能由 TOPS 換算實際 token/s。[NVIDIA 推論說明](https://developer.nvidia.com/blog/mastering-llm-techniques-inference-optimization/)

MoE 也不能只看啟用參數：DeepSeek-V3 主模型共有 671B、每 token 啟用 37B；若要完整駐留，仍需容納總權重。啟用量有助理解運算需求，卻不是包含快取、批次與通訊的速度公式。[開發者模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V3)

| 架構 | 代表容量 | 選型重點 |
|---|---|---|
| Apple 統一記憶體 | M5 Max 最高 128GB；M5 Ultra 已公布最高 512GB | 大共享工作集、Metal／MLX 相容性 |
| 單張 NVIDIA | RTX 5090 32GB；RTX PRO 6000 Workstation 96GB | CUDA 工作流、單卡容量上限 |
| 多 GPU | 分散在各卡的 VRAM | 模型切分、互連與整機設計 |
| CPU 大記憶體 | Xeon 例子支援最高 3–4TB | 主機板／DIMM 配置與實際頻寬 |

**Apple：適合重視大模型容量、願意採用 Mac 軟體路線的人。** Mac Studio 官方規格列 M5 Max 頻寬 460 或 614GB/s，M5 Ultra 為 1.2TB/s；最高 512GB 配置依發布公告預定 2026 年 10 月下旬供貨，查閱時不能視為已到貨選項。[規格](https://www.apple.com/mac-studio/specs/)、[供貨公告](https://www.apple.com/newsroom/2026/08/apple-introduces-new-mac-studio-with-m5-max-and-m5-ultra/)

MLX 讓 CPU／GPU 共用陣列而免除兩者間的資料複製，減少獨立 RAM／VRAM 的容量分割；但系統總記憶體不等於模型可用容量，仍須留工作集餘裕。[MLX 文件](https://ml-explore.github.io/mlx/build/html/index.html) 可用 Metal、MLX 及社群 vLLM-Metal 路線；後者使用 MLX 後端，功能與模型格式需逐項確認，不能把 CUDA 專用程式當成直接相容。[vLLM 安裝文件](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/)

**單張 NVIDIA：若既有工具依賴 CUDA，優先評估這條路。** RTX 5090 為 32GB、575W TGP；RTX PRO 6000 Blackwell Workstation Edition 為 96GB ECC、600W 板卡功耗，兩者標示記憶體頻寬均為 1792GB/s。96GB 提供較大的模型與快取空間，容量不代表速度。[5090 規格](https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090/)、[5090 頻寬公告](https://www.nvidia.com/en-us/geforce/news/rtx-50-series-graphics-cards-gpu-laptop-announcements/)、[PRO 資料表](https://www.nvidia.com/content/dam/en-zz/Solutions/data-center/rtx-pro-6000-blackwell-workstation-edition/workstation-blackwell-rtx-pro-6000-workstation-edition-nvidia-us-3519208-web.pdf)

上述 70B／4-bit 算例已超過 32GB；可改用較小模型、更低位元量化、CPU 卸載或更大顯存。量化品質與速度都要驗證。軟體亦需匹配驅動、CUDA、PyTorch 與量化核心版本；vLLM 的 CUDA 路線以 Linux 為主，Windows 可經 WSL，並非原生等同支援。[安裝要求](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/)

**多 GPU：容量或併發需求明確超出單卡，再承擔複雜度。** 兩張 32GB 不會自動變成一張 64GB；需 tensor／pipeline parallel 等模型切分。5090 沒有 NVLink；vLLM 在單節點缺乏 NVLink 等情境建議考慮 pipeline，說明卡內頻寬與卡間通訊是不同瓶頸。分卡各跑完整模型可增加併發，卻不增加單模型容量；吞吐提升也不等於單人回覆延遲同比下降。[vLLM 平行化文件](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/)

還要核對 PCIe 實際通道、插槽空間、電源與散熱。PRO 6000 Max-Q 同為 96GB，但標示 300W、定位最多四卡密集工作站，不能與 600W Workstation 版混用規格。[NVIDIA 家族比較](https://www.nvidia.com/en-us/products/workstations/professional-desktop-gpus/rtx-pro-6000-family/)

**CPU 大記憶體：適合容量優先、可接受較長等待或混合卸載的用途。** 伺服器級 Xeon 6978P 支援最高 3TB、12 通道，官方最高記憶體速度為 8800MT/s；6776P 則為 4TB、8 通道、8000MT/s。通道較多不代表容量較大，傳輸率也不是推論速度；這些是處理器支援上限，實裝仍受主機板、DIMM 與韌體限制，並須核對機箱散熱。[6978P](https://www.intel.com/content/www/us/en/products/sku/244340/intel-xeon-6978p-processor-504m-cache-2-10-ghz/specifications.html)、[6776P](https://www.intel.com/content/www/us/en/products/sku/243691/intel-xeon-6776p-processor-336m-cache-2-30-ghz/specifications.html)

llama.cpp 支援 CPU 與 CPU＋GPU 混合推論，可承載超出 VRAM 的模型。通道是否填滿、記憶體速度與卸載方式會影響體驗；容量大不代表生成快，也沒有足夠的同條件價格與實測支持「每 GB 最划算」。[llama.cpp 官方說明](https://github.com/ggml-org/llama.cpp)

另有 NVIDIA DGX Spark 這類共享記憶體小主機：128GB、273GB/s、Arm CPU；官方 200B 單機／405B 雙機宣稱以 FP4 為前提，資料表未給脈絡長度，不能視為任意工作負載保證。[Spark 資料表](https://dam-cdn.nvd.orangelogic.com/AssetLink/3lhuar5pc56pn7se4c7ahsskw20xw8h5.pdf) 官方另列微調最高 70B，仍非完整訓練承諾。[Spark 產品頁](https://www.nvidia.com/en-us/products/workstations/dgx-spark/)

AMD Ryzen AI Max 有官方 ROCm 路徑；7.1.1 的 Ryzen 文件列 gfx1151、核心版本要求，且共享記憶體池預設為系統記憶體一半，可調整。選購須按軟體版本確認可用容量與模型支援。[AMD Ryzen 指南](https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-7.1.1/docs/install/installryz/native_linux/install-ryzen.html)

成本只能分層看：Apple 的 2026 年發布起價是 US$2,499／5,499，並非最高記憶體配置價格；5090 的 US$1,999 是 2025 年上市起價，均非本次確認的現貨成交價。[Apple 公告](https://www.apple.com/newsroom/2026/08/apple-introduces-new-mac-studio-with-m5-max-and-m5-ultra/)、[NVIDIA 公告](https://www.nvidia.com/en-us/geforce/news/rtx-50-series-graphics-cards-gpu-laptop-announcements/) PRO 卡、DIMM、整機、稅與供貨需另詢價，還要計入 SSD、耗電、散熱及維護時間。TGP／TDP 不是整機實測耗電。

**本報告建議的評估順序是：先試能容納目標工作負載的單卡；容量超出時，依軟體需求比較 Apple、大顯存單卡與 CPU；確有擴充需求才上多卡。** 購買前用同一模型、量化、脈絡長度及併發量，測首字延遲、生成速度與記憶體峰值；本報告未取得這種跨平台實測，因此不提供速度排名。
