FROM python:3.14 AS base

WORKDIR /root/src

COPY ./requirements.txt ./requirements.txt

# ---- Dependencies ----
FROM base AS pybuilder
RUN pip install --user -r requirements.txt

FROM base
WORKDIR /code

COPY --from=pybuilder /root/.local /root/.local
# pip install --user puts console_scripts in /root/.local/bin so
# gunicorn (and any future scripts) need to be discoverable on PATH.
ENV PATH=/root/.local/bin:$PATH

COPY . ./

# Production WSGI server. Two gthread workers, 8 threads each.
# - Worker count: the python container has a 4 GB memory cap; pandas
#   pipelines on a single big game can spike to 1+ GB transient
#   memory, so 2 workers keeps headroom for one outlier without OOM.
# - gthread + 8 threads per worker: Flask handlers spend most of their
#   wall time waiting on ESPN's CDN and the XGBoost predict calls
#   (which release the GIL); thread-per-request handles concurrency
#   well without paying for additional fork copies of the loaded
#   models.
# - 120s timeout: cold game-page processing can run 5-6s on the
#   slowest games; 120s is well above the long tail without masking
#   genuine hangs.
CMD ["gunicorn", "-w", "2", "-k", "gthread", "--threads", "8", "--timeout", "120", "-b", "0.0.0.0:7000", "app:app"]
